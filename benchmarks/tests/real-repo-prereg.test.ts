import { describe, expect, it } from 'vitest';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import { summarizeBranches, type BranchOutcome, type BranchRecord, type EndReason } from '../real-repo/branch.js';
import {
  G1_MAX_FALSE_PASS_SHARE,
  G1_MIN_EXTRA_RESOLVED,
  G1_RUNS_PER_ISSUE,
  G2_MIN_BRANCH_POINTS,
  G2_MIN_RATE_GAP,
  G2_MIN_RATE_RATIO,
  G2_SEEDS,
  PREREG_AMENDMENTS,
  REPRO_FALLBACK_MAX_FAITHFUL,
  controlCost,
  describeG1,
  devPoolIds,
  evaluateG1,
  evaluateG2,
  heldOutPoolIds,
  renderG2Report,
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

describe('pre-registered constants (Amendment 1 adds, changes none)', () => {
  it('keeps every threshold as registered at ff01479', () => {
    expect(REPRO_FALLBACK_MAX_FAITHFUL).toBe(5);
    expect(G1_MIN_EXTRA_RESOLVED).toBe(2);
    expect(G1_MAX_FALSE_PASS_SHARE).toBe(0.25);
    expect(G2_MIN_BRANCH_POINTS).toBe(15);
    expect(G2_MIN_RATE_GAP).toBe(0.2);
    expect(G2_MIN_RATE_RATIO).toBe(2);
  });

  it('fixes the run counts and records the amendment', () => {
    expect(G1_RUNS_PER_ISSUE).toBe(1);
    expect(G2_SEEDS).toEqual({ dev: 3, 'held-out': 1 });
    expect(PREREG_AMENDMENTS.map(a => [a.id, a.date])).toEqual([['amendment-1', '2026-10-02']]);
    expect(PREREG_AMENDMENTS[0].summary).toContain('before any G1/G2 run');
  });
});

// ── G2 report: strata and cost ───────────────────────────────────────

const outcome = (resolved: boolean, extra: Partial<BranchOutcome> = {}): BranchOutcome =>
  ({ agent: 'a', checkPassed: resolved, checkTail: '', hidden: hidden(resolved), modelCalls: 1, toolCalls: 1, ...extra });

/** The G2 decision exactly as registered at ff01479, kept here as the reference. */
function g2AsRegistered(records: readonly BranchRecord[]) {
  const paired = records.filter(r => r.branched && r.controls.R && !r.controls.R.error && r.controls.C0 && !r.controls.C0.error);
  const summary = summarizeBranches(paired);
  const rateR = summary.R?.rate;
  const rateC0 = summary.C0?.rate;
  const powered = paired.length >= 15;
  const confirmed = powered && rateR !== undefined && rateC0 !== undefined && rateR - rateC0 >= 0.2 && rateR >= 2 * rateC0;
  return {
    branchPoints: paired.length,
    ...(rateR !== undefined ? { rateR } : {}),
    ...(rateC0 !== undefined ? { rateC0 } : {}),
    ...(summary.C1 ? { rateC1: summary.C1.rate } : {}),
    powered,
    confirmed,
  };
}

describe('G2 report (reporting only)', () => {
  it('leaves the decision exactly as registered, whatever the strata and cost fields hold', () => {
    // A deterministic generator: many record sets, mixed end reasons, billing, errors and C1.
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const ends: Array<EndReason | undefined> = ['answered', 'turn_cap', 'wall_clock', 'budget', 'unreadable', 'error', undefined];
    let confirmedSets = 0;
    let poweredSets = 0;
    for (let set = 0; set < 300; set++) {
      const n = Math.floor(rand() * 30);
      const pR = rand();
      const pC0 = rand() * 0.5;
      const records: BranchRecord[] = Array.from({ length: n }, (_, i) => {
        const end = ends[Math.floor(rand() * ends.length)];
        const billed = rand() < 0.5 ? { billedCostUsd: rand() / 10 } : {};
        const controls: BranchRecord['controls'] = {
          R: outcome(rand() < pR, { tokens: Math.floor(rand() * 1e6), ...billed, ...(rand() < 0.05 ? { error: 'x' } : {}) }),
          C0: outcome(rand() < pC0, { tokens: Math.floor(rand() * 1e6), ...billed, ...(rand() < 0.05 ? { error: 'x' } : {}) }),
          ...(rand() < 0.5 ? { C1: outcome(rand() < 0.5, billed) } : {}),
        };
        return {
          instanceId: `i${i}`, seed: 0, checkMode: 'visible-f2p', branched: rand() < 0.9,
          stage1: outcome(false, end ? { endReason: end } : { status: rand() < 0.5 ? 'completed' : 'failed', agentError: 'Reached max iterations (30)' }),
          controls,
        };
      });
      const { strata, cost, ...decision } = evaluateG2(records);
      expect(decision).toEqual(g2AsRegistered(records));
      if (decision.powered) poweredSets++;
      if (decision.confirmed) confirmedSets++;
      // The strata partition the same branch points.
      expect(Object.values(strata).reduce((s, x) => s + (x?.branchPoints ?? 0), 0)).toBe(decision.branchPoints);
      if (decision.branchPoints === 0) expect(cost).toEqual({});
    }
    // The generator reaches both verdicts.
    expect(poweredSets).toBeGreaterThan(0);
    expect(confirmedSets).toBeGreaterThan(0);
    expect(confirmedSets).toBeLessThan(poweredSets);
  });

  it('gives each stratum of stage-1 endings its own rates', () => {
    const point = (end: EndReason | undefined, r: boolean, c0: boolean, c1?: boolean, legacy?: { status: string; agentError?: string }): BranchRecord => ({
      instanceId: 'x', seed: 0, checkMode: 'visible-f2p', branched: true,
      stage1: outcome(false, end ? { endReason: end } : legacy ?? {}),
      controls: { R: outcome(r), C0: outcome(c0), ...(c1 !== undefined ? { C1: outcome(c1) } : {}) },
    });
    const g2 = evaluateG2([
      point('turn_cap', true, false, true),
      point('turn_cap', true, true, false),
      point('turn_cap', false, false, false),
      point('answered', false, false),
      // A record from before the amendment: the end reason is read from its status.
      point(undefined, true, false, undefined, { status: 'completed' }),
    ]);
    expect(g2.strata).toEqual({
      answered: { branchPoints: 2, rateR: 0.5, rateC0: 0 },
      turn_cap: { branchPoints: 3, rateR: 2 / 3, rateC0: 1 / 3, rateC1: 1 / 3 },
    });
    expect(renderG2Report(g2)).toContain('| turn_cap | 3 | 67% | 33% | 33% |');
  });

  it('reports cost per control, with billed figures absent when nothing was billed', () => {
    const g2 = evaluateG2([
      { instanceId: 'a', seed: 0, checkMode: 'visible-f2p', branched: true, stage1: outcome(false),
        controls: { R: outcome(true, { tokens: 1000, billedCostUsd: 0.02 }), C0: outcome(false, { tokens: 3000 }) } },
      { instanceId: 'b', seed: 0, checkMode: 'visible-f2p', branched: true, stage1: outcome(false),
        controls: { R: outcome(false, { tokens: 2000, billedCostUsd: 0.03 }), C0: outcome(true, { tokens: 5000 }) } },
    ]);
    expect(g2.cost.R).toEqual({ runs: 2, meanTokens: 1500, meanBilledUsd: 0.025, billedRuns: 2, hiddenResolved: 1, resolvedPerBilledUsd: 1 / 0.05 });
    expect(g2.cost.C0).toEqual({ runs: 2, meanTokens: 4000, billedRuns: 0, hiddenResolved: 1 });
    expect(g2.cost.C1).toBeUndefined();
    // Partly billed: the per-dollar figure uses only the runs that reported a billed cost.
    expect(controlCost([outcome(true, { billedCostUsd: 0.5 }), outcome(true)])).toMatchObject({ billedRuns: 1, meanBilledUsd: 0.5, hiddenResolved: 2, resolvedPerBilledUsd: 2 });
    expect(renderG2Report(g2)).toContain('| C0 | 2 | 4000 | — | 0 | 1 | — |');
    // No tokens recorded: no mean, not a mean of 0.
    expect('meanTokens' in controlCost([outcome(true), outcome(false)])).toBe(false);
  });
});

// ── G1 report ────────────────────────────────────────────────────────

describe('G1 report (reporting only)', () => {
  type Stage = {
    passed: boolean; hidden?: boolean; status?: string; error?: string;
    secondary?: { files: number; regressed: number };
    audit?: { testInfraChanged: string[]; suspicious: Array<{ file: string; reason: string; line: string }> };
  };
  const run = (id: string, final: boolean, stage1: boolean, stages: Stage[], billed?: number): CrewScalingRecord => ({
    runId: id, taskId: id, workloadId: id, crewWidth: 1, roles: [], seed: 0, success: final, agentResults: [],
    hidden: hidden(final), stage1Hidden: hidden(stage1),
    ...(billed !== undefined ? { totalBilledCostUsd: billed } : {}),
    staged: {
      stagesExecuted: stages.length, verified: final,
      ...(stages.findIndex(s => s.passed) >= 0 ? { solvedAtStage: stages.findIndex(s => s.passed) + 1 } : {}),
      stages: stages.map((s, i) => ({
        stage: i + 1, agentId: 'a', role: 'r', executed: true,
        ...(s.status ? { status: s.status } : {}), ...(s.error ? { error: s.error } : {}),
        verification: { passed: s.passed, output: '' },
        ...(s.hidden !== undefined ? {
          observation: {
            hidden: hidden(s.hidden),
            ...(s.secondary ? { secondary: s.secondary } : {}),
            ...(s.audit ? { audit: { changedFiles: [], testFilesAdded: [], ...s.audit } } : {}),
          },
        } : {}),
      })),
    },
  });
  const clean = { testInfraChanged: [], suspicious: [] };

  const records = [
    // Recovered after the implementer hit the turn cap.
    run('a', true, false, [
      { passed: false, hidden: false, status: 'failed', error: 'Reached max iterations (30) without completing', audit: clean },
      { passed: true, hidden: true, status: 'completed', secondary: { files: 2, regressed: 0 }, audit: clean },
    ], 0.04),
    // Recovered after the implementer answered wrongly; the passing stage regressed a secondary test.
    run('b', true, false, [
      { passed: false, hidden: false, status: 'completed', audit: clean },
      { passed: true, hidden: true, status: 'completed', secondary: { files: 1, regressed: 1 }, audit: clean },
    ], 0.06),
    // Stage 1 resolved; its pass edited a conftest.py, and no secondary test file matched.
    run('c', true, true, [{ passed: true, hidden: true, status: 'completed', secondary: { files: 0, regressed: 0 }, audit: { testInfraChanged: ['tests/conftest.py'], suspicious: [] } }]),
    // A hidden false pass with a suspicious line.
    run('d', false, false, [{ passed: true, hidden: false, status: 'completed', secondary: { files: 1, regressed: 0 }, audit: { testInfraChanged: [], suspicious: [{ file: 'src/x.py', reason: 'r', line: 'l' }] } }]),
  ];

  it('counts recoveries by how the stage before the solving stage ended, and billed cost', () => {
    const report = describeG1(records);
    expect(report.recoveries).toBe(2);
    expect(report.recoveriesByPrecedingEnd).toEqual({ turn_cap: 1, answered: 1 });
    expect(report.unattributedRecoveries).toBe(0);
    expect(report.billedRuns).toBe(2);
    expect(report.meanBilledUsd).toBeCloseTo(0.05);
    expect(report.runs).toBe(4);
    expect('meanBilledUsd' in describeG1([records[2]])).toBe(false);
  });

  it('extends false passes to secondary regressions and audit flags', () => {
    const x = describeG1(records).extendedFalsePasses;
    expect(x).toMatchObject({ checkPasses: 4, hiddenFailed: 1, secondaryRegressed: 1, secondaryNoFiles: 1, testInfraChanged: 1, suspicious: 1, flagged: 3 });
    expect(x.stages).toEqual([
      { runId: 'b', workloadId: 'b', stage: 2, reasons: ['secondary regression'] },
      { runId: 'c', workloadId: 'c', stage: 1, reasons: ['test infrastructure changed'] },
      { runId: 'd', workloadId: 'd', stage: 1, reasons: ['hidden tests failed', 'suspicious source lines'] },
    ]);
  });

  it('does not change what evaluateG1 decides', () => {
    // The same runs without any of the new observations: G1 is identical.
    const strip = (r: CrewScalingRecord): CrewScalingRecord => ({
      ...r,
      staged: { ...r.staged!, stages: r.staged!.stages.map(s => ({ ...s, ...(s.observation ? { observation: { hidden: s.observation.hidden } } : {}) })) },
    });
    expect(evaluateG1(records)).toEqual(evaluateG1(records.map(strip)));
    expect(evaluateG1(records)).toMatchObject({ runs: 4, stagedResolved: 3, stage1Resolved: 1, checkPasses: 4, falsePasses: 1, falsePassShare: 0.25, confirmed: false });
    // Without the hidden false pass it clears the bar, extended flags notwithstanding.
    expect(evaluateG1(records.slice(0, 3)).confirmed).toBe(true);
    expect(describeG1(records.slice(0, 3)).extendedFalsePasses.flagged).toBe(2);
  });
});
