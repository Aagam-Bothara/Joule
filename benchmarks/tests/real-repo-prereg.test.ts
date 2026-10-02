import { describe, expect, it } from 'vitest';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import type { BranchRecord } from '../real-repo/branch.js';
import {
  devPoolIds,
  evaluateG1,
  evaluateG2,
  heldOutPoolIds,
  reproFallback,
  selectReproItems,
} from '../real-repo/prereg.js';
import { localDjangoCandidates } from '../real-repo/selftest.js';
import { imageFor } from '../real-repo/workload.js';
import { DJANGO_ITEM, FLASK_ITEM, ITEM } from './real-repo-fixtures.js';

const hidden = (resolved: boolean) => ({ resolved, f2pPassed: resolved ? 1 : 0, f2pTotal: 1, p2pFailed: 0, p2pTotal: 1 });

describe('pre-registered pools', () => {
  it('takes the first usable Django instances in id order, excluding the dev pool', () => {
    const rows = [
      { instanceId: 'django__django-13000', usable: true },
      { instanceId: 'django__django-11000', usable: false },
      { instanceId: 'django__django-12000', usable: true },
      { instanceId: 'pallets__flask-4045', usable: true },
      { instanceId: 'django__django-10000', usable: true },
    ];
    expect(heldOutPoolIds(rows, ['django__django-12000'], 30)).toEqual(['django__django-10000', 'django__django-13000']);
    expect(heldOutPoolIds(rows, [], 1)).toEqual(['django__django-10000']);
    expect(devPoolIds(rows)).toEqual(['django__django-10000', 'django__django-12000', 'django__django-13000', 'pallets__flask-4045']);
  });

  it('self-tests only Django instances whose image is already local', () => {
    const items = [{ ...DJANGO_ITEM, instance_id: 'django__django-2' }, { ...DJANGO_ITEM, instance_id: 'django__django-1' }, FLASK_ITEM, { ...DJANGO_ITEM, instance_id: 'django__django-3' }];
    const images = new Set([imageFor('django__django-2'), imageFor('django__django-1'), imageFor(FLASK_ITEM.instance_id)]);
    expect(localDjangoCandidates(items, images).map(i => i.instance_id)).toEqual(['django__django-1', 'django__django-2']);
  });

  it('uses only faithful reproduction tests unless told otherwise, and falls back at five or fewer', () => {
    const repros = new Map([[ITEM.instance_id, { source: 'a', faithful: true }], [FLASK_ITEM.instance_id, { source: 'b', faithful: false }]]);
    const strict = selectReproItems([ITEM, FLASK_ITEM, DJANGO_ITEM], repros);
    expect(strict.items.map(i => i.instance_id)).toEqual([ITEM.instance_id]);
    expect(strict.skipped).toEqual([
      { instanceId: FLASK_ITEM.instance_id, reason: 'reproduction test is not faithful' },
      { instanceId: DJANGO_ITEM.instance_id, reason: 'no reproduction test' },
    ]);
    expect(selectReproItems([ITEM, FLASK_ITEM], repros, true).items).toHaveLength(2);
    expect(reproFallback(5)).toBe(true);
    expect(reproFallback(6)).toBe(false);
  });
});

describe('pre-registered decision rules', () => {
  const run = (final: boolean, stage1: boolean, stages: Array<{ passed: boolean; hidden?: boolean }>): CrewScalingRecord => ({
    runId: 'r', taskId: 't', workloadId: 'w', crewWidth: 1, roles: [], seed: 0, success: final, agentResults: [],
    hidden: hidden(final), stage1Hidden: hidden(stage1),
    staged: {
      stagesExecuted: stages.length, verified: final,
      stages: stages.map((s, i) => ({
        stage: i + 1, agentId: 'a', role: 'r', executed: true,
        verification: { passed: s.passed, output: '' },
        ...(s.hidden !== undefined ? { observation: { hidden: hidden(s.hidden) } } : {}),
      })),
    },
  });

  it('G1: needs two more hidden resolutions than stage 1 and under a quarter false passes', () => {
    const records = [
      run(true, false, [{ passed: false, hidden: false }, { passed: true, hidden: true }]),
      run(true, false, [{ passed: false, hidden: false }, { passed: true, hidden: true }]),
      run(true, true, [{ passed: true, hidden: true }]),
      run(false, false, [{ passed: true, hidden: false }]),
    ];
    const g1 = evaluateG1(records);
    expect(g1).toMatchObject({ runs: 4, stagedResolved: 3, stage1Resolved: 1, checkPasses: 4, falsePasses: 1, falsePassShare: 0.25, confirmed: false });
    // One fewer false pass and it clears the bar.
    expect(evaluateG1(records.slice(0, 3)).confirmed).toBe(true);
    // Runs without the separate scores are not counted, and say so.
    expect(evaluateG1([{ ...records[0], stage1Hidden: undefined }])).toMatchObject({ runs: 0, unscored: 1, confirmed: false });
  });

  it('G2: R must beat C0 by 20 points and double it, over at least 15 branch points', () => {
    const o = (resolved: boolean) => ({ agent: 'a', checkPassed: resolved, checkTail: '', hidden: hidden(resolved), modelCalls: 1, toolCalls: 1 });
    const points = (n: number, rRate: number, c0Rate: number): BranchRecord[] => Array.from({ length: n }, (_, i) => ({
      instanceId: `i${i}`, seed: 0, checkMode: 'repro', stage1: o(false), branched: true,
      controls: { R: o(i < Math.round(rRate * n)), C0: o(i < Math.round(c0Rate * n)) },
    }));
    expect(evaluateG2(points(20, 0.5, 0.2))).toMatchObject({ branchPoints: 20, rateR: 0.5, rateC0: 0.2, powered: true, confirmed: true });
    expect(evaluateG2(points(20, 0.6, 0.35)).confirmed).toBe(false); // gap 25 points, but not double
    expect(evaluateG2(points(20, 0.3, 0.15)).confirmed).toBe(false); // double, but a 15-point gap
    expect(evaluateG2(points(10, 0.6, 0.1))).toMatchObject({ powered: false, confirmed: false });
  });
});
