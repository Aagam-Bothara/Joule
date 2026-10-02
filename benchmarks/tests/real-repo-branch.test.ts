import { describe, expect, it } from 'vitest';
import type { AgentDefinition, AgentResult, CrewResult, Task, VerifiedEditPolicy } from '@joule/shared';
import { billingByControl, endReasonOf, parseControls, runBranchPoint, summarizeBranches, type BranchDeps, type BranchRecord } from '../real-repo/branch.js';
import type { DiffAudit } from '../real-repo/audit.js';
import type { HiddenScore, SecondaryScore } from '../real-repo/checks.js';
import type { PreparedInstance } from '../real-repo/workload.js';
import { ITEM } from './real-repo-fixtures.js';

const agent = (id: string): AgentDefinition => ({ id, role: id, instructions: id, allowedTools: [] });
const AGENTS = { implementer: agent('implementer'), reviewer: agent('reviewer') };

function crew(answer: string, tokens = 1000, ended: { status: string; error?: string } = { status: 'completed' }): CrewResult {
  return {
    crewName: 'x', status: 'completed', result: answer,
    agentResults: [{
      agentId: 'a', role: 'r', blackboardWrites: [],
      budgetUsed: { tokensUsed: tokens, costUsd: 0.01 },
      taskResult: {
        id: 't', taskId: 't', traceId: 't', status: ended.status, ...(ended.error ? { error: ended.error } : {}), result: answer, stepResults: [], completedAt: '',
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
const AUDIT: DiffAudit = { changedFiles: ['src/x.py'], testInfraChanged: [], testFilesAdded: [], suspicious: [] };
const SECONDARY: SecondaryScore = { files: 1, regressed: 0 };

function world(opts: { stage1Passes: boolean; solves: Record<string, boolean>; failControl?: string; mode?: 'repro' | 'oracle'; stage1Ended?: { status: string; error?: string } }) {
  const log: string[] = [];
  let state = 'base';
  let containers = 0;
  let lastRunner = '';
  const prepared = (): PreparedInstance => {
    containers++;
    state = 'base';
    log.push(`prepare#${containers}`);
    return {
      container: `c${containers}`, dir: '/d', mode: opts.mode ?? 'repro', checkFaithful: true,
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
      return crew(`${a.id} says done`, 1000, lastRunner === 'stage1' && opts.stage1Ended ? opts.stage1Ended : { status: 'completed' });
    },
    verify: async (_policy: VerifiedEditPolicy) => {
      const passed = lastRunner === 'stage1' ? opts.stage1Passes : opts.solves[lastRunner] === true;
      return { passed, output: passed ? 'CHECK: PASSED' : 'CHECK: reproduction test FAILED (0 passed, 1 failed)' };
    },
    recoveryTask: (task: Task, _policy: VerifiedEditPolicy, previous: readonly AgentResult[], checked) =>
      ({ ...task, description: `${task.description}\n[evidence from ${previous[0].taskResult.result}: ${checked.output}]` }),
    scoreHidden: () => score(lastRunner === 'stage1' ? opts.stage1Passes : opts.solves[lastRunner] === true),
    scoreSecondary: c => { log.push(`secondary ${c}`); return SECONDARY; },
    auditDiff: (c, _i, mode) => { log.push(`audit ${c} ${mode}`); return AUDIT; },
    captureDiff: () => { log.push(`capture ${state}`); return 'diff --git a/src/x.py b/src/x.py\n'; },
    restoreBranch: (_c, _i, diff) => { state = diff ? 'branch' : 'base'; log.push('restore branch'); },
    saveDiff: () => '/out/diffs/x.diff',
  };
  return { deps, log, tasks };
}

describe('how an agent run ended', () => {
  it('classifies status and error into an end reason', () => {
    expect(endReasonOf({ status: 'completed' })).toBe('answered');
    // An answer is an answer, whatever error text came with it.
    expect(endReasonOf({ status: 'completed', error: 'Reached max iterations' })).toBe('answered');
    expect(endReasonOf({ status: 'failed', error: 'Reached max iterations (30) without completing' })).toBe('turn_cap');
    expect(endReasonOf({ status: 'failed', error: 'Wall-clock timeout exceeded (1800s)' })).toBe('wall_clock');
    expect(endReasonOf({ status: 'failed', error: 'Budget exhausted during direct execution' })).toBe('budget');
    expect(endReasonOf({ status: 'failed', error: 'LLM returned a tool call that could not be parsed; last reply: "x"' })).toBe('unreadable');
    expect(endReasonOf({ status: 'failed', error: 'LLM returned empty response' })).toBe('unreadable');
    expect(endReasonOf({ status: 'failed', error: 'LLM returned response without tool_calls or answer' })).toBe('unreadable');
    expect(endReasonOf({ status: 'failed', error: 'LLM call failed: 502 Bad Gateway' })).toBe('error');
    expect(endReasonOf({ status: 'failed' })).toBe('error');
    expect(endReasonOf({})).toBe('error');
  });
});

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
    // The audit (read-only) after every run; the secondary score only after a passing check.
    expect(w.log).toEqual([
      'prepare#1', 'agent implementer on base', 'audit c1 repro', 'capture implementer-work',
      'prepare#2', 'restore branch', 'agent reviewer on branch', 'audit c2 repro', 'secondary c2',
      'prepare#3', 'restore branch', 'agent implementer on branch', 'audit c3 repro',
      'prepare#4', 'restore branch', 'agent implementer on branch', 'audit c4 repro', 'secondary c4',
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

    // Reporting only: every outcome carries the audit; the secondary score only after a passing check.
    expect(record.stage1.audit).toEqual(AUDIT);
    expect(record.stage1.secondary).toBeUndefined();
    expect(record.controls.R).toMatchObject({ audit: AUDIT, secondary: SECONDARY, endReason: 'answered' });
    expect(record.controls.C0?.audit).toEqual(AUDIT);
    expect(record.controls.C0 && 'secondary' in record.controls.C0).toBe(false);
  });

  it('records how stage 1 ended, keeping the agent\'s error apart from a control that failed to run', async () => {
    const w = world({ stage1Passes: false, solves: { C0: true }, stage1Ended: { status: 'failed', error: 'Reached max iterations (30) without completing' } });
    const record = await runBranchPoint(ITEM, 0, ['C0'], AGENTS, w.deps);
    expect(record.stage1).toMatchObject({ endReason: 'turn_cap', agentError: 'Reached max iterations (30) without completing' });
    // `error` stays reserved for a control that could not run: it is what removes a run from the rates.
    expect(record.stage1.error).toBeUndefined();
    expect(summarizeBranches([record]).C0).toEqual({ branchPoints: 1, checkPasses: 1, hiddenResolved: 1, rate: 1 });

    const failed = await runBranchPoint(ITEM, 0, ['R'], AGENTS, world({ stage1Passes: false, solves: {}, failControl: 'R' }).deps);
    expect(failed.controls.R).toMatchObject({ endReason: 'error', error: 'provider exploded' });
  });

  it('a reporting measurement that throws never turns a control into a failed one', async () => {
    const w = world({ stage1Passes: false, solves: { R: true } });
    const deps: BranchDeps = {
      ...w.deps,
      auditDiff: () => { throw new Error('audit broke'); },
      scoreSecondary: () => { throw new Error('secondary broke'); },
    };
    const record = await runBranchPoint(ITEM, 0, ['R'], AGENTS, deps);
    expect(record.controls.R?.error).toBeUndefined();
    expect(record.controls.R).toMatchObject({ hidden: { resolved: true }, audit: { error: 'audit broke' }, secondary: { error: 'secondary broke' } });
    expect(summarizeBranches([record]).R).toMatchObject({ branchPoints: 1, rate: 1 });
  });

  it('measures neither the audit nor the secondary score in oracle mode', async () => {
    const w = world({ stage1Passes: true, solves: {}, mode: 'oracle' });
    const record = await runBranchPoint(ITEM, 0, ['R'], AGENTS, w.deps);
    expect(w.log.some(l => l.startsWith('audit') || l.startsWith('secondary'))).toBe(false);
    expect('audit' in record.stage1 || 'secondary' in record.stage1).toBe(false);
  });

  it('sums tokens and billed cost per run kind for the manifest', async () => {
    const w = world({ stage1Passes: false, solves: { R: true } });
    const record = await runBranchPoint(ITEM, 0, ['R', 'C0'], AGENTS, w.deps);
    const billing = billingByControl([record]);
    expect(billing.stage1).toEqual({ runs: 1, erroredRuns: 0, totalTokens: 1000, totalBilledCostUsd: 0.02, billedRuns: 1 });
    expect(billing.R).toEqual({ runs: 1, erroredRuns: 0, totalTokens: 1000, totalBilledCostUsd: 0.02, billedRuns: 1 });
    expect(billing.C1).toBeUndefined();
    const unbilled = { ...record, stage1: { ...record.stage1, billedCostUsd: undefined } };
    expect(billingByControl([unbilled]).stage1).toEqual({ runs: 1, erroredRuns: 0, totalTokens: 1000, totalBilledCostUsd: null, billedRuns: 0 });
    // A control that failed to run is left out of the sums, as from every rate and from G2's cost.
    const failed = await runBranchPoint(ITEM, 0, ['R'], AGENTS, world({ stage1Passes: false, solves: {}, failControl: 'R' }).deps);
    expect(billingByControl([failed]).R).toEqual({ runs: 0, erroredRuns: 1, totalTokens: 0, totalBilledCostUsd: null, billedRuns: 0 });
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
