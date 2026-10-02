import { describe, expect, it } from 'vitest';
import type { AgentDefinition, AgentResult, CrewResult, Task, VerifiedEditPolicy } from '@joule/shared';
import { parseControls, runBranchPoint, summarizeBranches, type BranchDeps, type BranchRecord } from '../real-repo/branch.js';
import type { HiddenScore } from '../real-repo/checks.js';
import type { PreparedInstance } from '../real-repo/workload.js';
import { ITEM } from './real-repo-fixtures.js';

const agent = (id: string): AgentDefinition => ({ id, role: id, instructions: id, allowedTools: [] });
const AGENTS = { implementer: agent('implementer'), reviewer: agent('reviewer') };

function crew(answer: string, tokens = 1000): CrewResult {
  return {
    crewName: 'x', status: 'completed', result: answer,
    agentResults: [{
      agentId: 'a', role: 'r', blackboardWrites: [],
      budgetUsed: { tokensUsed: tokens, costUsd: 0.01 },
      taskResult: {
        id: 't', taskId: 't', traceId: 't', status: 'completed', result: answer, stepResults: [], completedAt: '',
        lifecycleMetrics: { modelCalls: 3, toolCalls: 4 }, billedCostUsd: 0.02, billedModelCalls: 3,
      },
    }],
    budgetUsed: { tokensUsed: tokens, costUsd: 0.01 },
  } as unknown as CrewResult;
}

const score = (resolved: boolean): HiddenScore => ({ resolved, f2pPassed: resolved ? 1 : 0, f2pTotal: 1, p2pFailed: 0, p2pTotal: 2 });

/**
 * A scripted world: which agent runs make the check and hidden tests pass,
 * and a log of every container operation in order.
 */
function world(opts: { stage1Passes: boolean; solves: Record<string, boolean>; failControl?: string }) {
  const log: string[] = [];
  let state = 'base';
  let containers = 0;
  let lastRunner = '';
  const prepared = (): PreparedInstance => {
    containers++;
    state = 'base';
    log.push(`prepare#${containers}`);
    return {
      container: `c${containers}`, dir: '/d', mode: 'repro', checkFaithful: true,
      description: 'Fix the issue.', verifyCommand: 'node run-check', verifyLabel: 'the check',
      check: () => ({ passed: false, output: '' }), verify: () => ({ success: false, output: '' }),
    } as PreparedInstance;
  };
  const tasks: Array<{ agent: string; task: Task }> = [];
  const deps: BranchDeps = {
    prepare: () => prepared(),
    runAgent: async (a, task) => {
      tasks.push({ agent: a.id, task });
      lastRunner = tasks.length === 1 ? 'stage1' : task.id.split('-').pop()!;
      log.push(`agent ${a.id} on ${state}`);
      if (opts.failControl && lastRunner === opts.failControl) throw new Error('provider exploded');
      state = lastRunner === 'stage1' ? 'implementer-work' : `${lastRunner}-work`;
      return crew(`${a.id} says done`);
    },
    verify: async (_policy: VerifiedEditPolicy) => {
      const passed = lastRunner === 'stage1' ? opts.stage1Passes : opts.solves[lastRunner] === true;
      return { passed, output: passed ? 'CHECK: PASSED' : 'CHECK: reproduction test FAILED (0 passed, 1 failed)' };
    },
    recoveryTask: (task: Task, _policy: VerifiedEditPolicy, previous: readonly AgentResult[], checked) =>
      ({ ...task, description: `${task.description}\n[evidence from ${previous[0].taskResult.result}: ${checked.output}]` }),
    scoreHidden: () => score(lastRunner === 'stage1' ? opts.stage1Passes : opts.solves[lastRunner] === true),
    captureDiff: () => { log.push(`capture ${state}`); return 'diff --git a/src/x.py b/src/x.py\n'; },
    restoreBranch: (_c, _i, diff) => { state = diff ? 'branch' : 'base'; log.push('restore branch'); },
    saveDiff: () => '/out/diffs/x.diff',
  };
  return { deps, log, tasks };
}

describe('branch points', () => {
  it('records no branch point when the implementer already passes the check', async () => {
    const w = world({ stage1Passes: true, solves: {} });
    const record = await runBranchPoint(ITEM, 0, ['R', 'C0', 'C1'], AGENTS, w.deps);
    expect(record.branched).toBe(false);
    expect(record.stage1).toMatchObject({ agent: 'implementer', checkPassed: true, hidden: { resolved: true }, tokens: 1000, billedCostUsd: 0.02, modelCalls: 3, toolCalls: 4 });
    expect(record.controls).toEqual({});
    expect(w.tasks).toHaveLength(1);
  });

  it('runs every control from the saved state in a fresh container, with the right agent and evidence', async () => {
    const w = world({ stage1Passes: false, solves: { R: true, C0: false, C1: true } });
    const record = await runBranchPoint(ITEM, 2, ['R', 'C0', 'C1'], AGENTS, w.deps);

    expect(record).toMatchObject({ instanceId: ITEM.instance_id, seed: 2, branched: true, checkMode: 'repro', checkFaithful: true, diffFile: '/out/diffs/x.diff' });
    // Each control: a fresh prepare, the branch replayed, then the agent.
    expect(w.log).toEqual([
      'prepare#1', 'agent implementer on base', 'capture implementer-work',
      'prepare#2', 'restore branch', 'agent reviewer on branch',
      'prepare#3', 'restore branch', 'agent implementer on branch',
      'prepare#4', 'restore branch', 'agent implementer on branch',
    ]);
    const [, r, c0, c1] = w.tasks;
    expect(r.agent).toBe('reviewer');
    expect(r.task.description).toContain('[evidence from implementer says done: CHECK: reproduction test FAILED');
    expect(c0.task.description).toBe('Fix the issue.');
    expect(c1.agent).toBe('implementer');
    expect(c1.task.description).toBe(r.task.description);
    // The check's policy travels with every task, so the gate is the same.
    for (const t of w.tasks) expect(t.task.verifiedEdit?.label).toBe('the check');

    expect(record.controls.R).toMatchObject({ agent: 'reviewer', checkPassed: true, hidden: { resolved: true } });
    expect(record.controls.C0).toMatchObject({ agent: 'implementer', checkPassed: false, hidden: { resolved: false } });
    expect(record.controls.C1).toMatchObject({ checkPassed: true, hidden: { resolved: true } });
  });

  it('records a control that failed and still runs the others', async () => {
    const w = world({ stage1Passes: false, solves: { R: true, C0: true }, failControl: 'R' });
    const record = await runBranchPoint(ITEM, 0, ['R', 'C0'], AGENTS, w.deps);
    expect(record.controls.R).toMatchObject({ error: 'provider exploded', hidden: { resolved: false } });
    expect(record.controls.C0).toMatchObject({ hidden: { resolved: true } });
  });

  it('runs only the controls asked for, and rejects unknown ones', async () => {
    const w = world({ stage1Passes: false, solves: {} });
    const record = await runBranchPoint(ITEM, 0, parseControls('C0'), AGENTS, w.deps);
    expect(Object.keys(record.controls)).toEqual(['C0']);
    expect(parseControls(undefined)).toEqual(['R', 'C0', 'C1']);
    expect(() => parseControls('R,X')).toThrow('unknown control X');
  });

  it('pools hidden recovery rates per control over branch points', () => {
    const o = (resolved: boolean) => ({ agent: 'a', checkPassed: resolved, checkTail: '', hidden: score(resolved), modelCalls: 1, toolCalls: 1 });
    const records: BranchRecord[] = [
      { instanceId: 'a', seed: 0, checkMode: 'repro', stage1: o(false), branched: true, controls: { R: o(true), C0: o(false) } },
      { instanceId: 'b', seed: 0, checkMode: 'repro', stage1: o(false), branched: true, controls: { R: o(true), C0: o(true) } },
      { instanceId: 'c', seed: 0, checkMode: 'repro', stage1: o(true), branched: false, controls: {} },
    ];
    expect(summarizeBranches(records)).toEqual({
      R: { branchPoints: 2, checkPasses: 2, hiddenResolved: 2, rate: 1 },
      C0: { branchPoints: 2, checkPasses: 1, hiddenResolved: 1, rate: 0.5 },
    });
  });
});
