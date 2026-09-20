import { describe, it, expect } from 'vitest';
import {
  aggregateByWidth,
  analyzeCrewScaling,
  byTask,
  dominanceSteps,
  marginalSteps,
  minimumWidths,
  oracleSavings,
  renderCrewScalingReport,
  renderRepeatability,
  repeatability,
} from '../crew-scaling/analyze.js';
import { contributionOf } from '../crew-scaling/record.js';
import type { CrewScalingRecord, CrewWidth } from '../crew-scaling/types.js';
import type { AgentLifecycleEvent, AgentLifecycleState, AgentResult, LifecycleMetrics } from '@joule/shared';

/** A record with sane defaults; every test overrides only what it asserts on. */
function rec(workloadId: string, crewWidth: CrewWidth, o: Partial<CrewScalingRecord> = {}): CrewScalingRecord {
  const agents = Array.from({ length: crewWidth }, (_, i) => ({
    agentId: `a${i}`, role: `r${i}`, success: true, costUsd: 0.001, tokens: 1000, modelCalls: 1, toolCalls: 1,
  }));
  return {
    runId: 'run-1',
    taskId: `task-${workloadId}-${crewWidth}`,
    seed: 0,
    workloadId,
    crewWidth,
    roles: agents.map(a => a.agentId),
    success: true,
    workflowJctMs: 10_000 * crewWidth,
    totalCostUsd: 0.001 * crewWidth,
    totalTokens: 1000 * crewWidth,
    modelCalls: crewWidth,
    toolCalls: crewWidth,
    modelRuntimeMs: 5000 * crewWidth,
    toolWaitMs: 1000 * crewWidth,
    activeAgents: crewWidth,
    agentResults: agents,
    ...o,
  };
}

describe('crew scaling analysis', () => {
  it('1. aggregates metrics by crew width', () => {
    const records = [
      rec('t1', 1), rec('t2', 1, { success: false }),
      rec('t1', 2), rec('t2', 2),
    ];
    const widths = aggregateByWidth(records);

    expect(widths.map(w => w.crewWidth)).toEqual([1, 2]);
    expect(widths[0]).toMatchObject({ runs: 2, successes: 1, successRate: 0.5 });
    expect(widths[1]).toMatchObject({ runs: 2, successes: 2, successRate: 1 });
    expect(widths[1].meanCostUsd).toBeCloseTo(0.002, 6);
    expect(widths[1].meanJctMs).toBe(20_000);
  });

  it('2. compares width 1 -> 2 on the same tasks', () => {
    const records = [
      rec('t1', 1, { success: false }), rec('t1', 2, { success: true }),
      rec('t2', 1, { success: true }), rec('t2', 2, { success: true }),
    ];
    const [step] = marginalSteps(records);

    expect(step).toMatchObject({ from: 1, to: 2, pairedTasks: 2, newlySolved: 1, regressions: 0, netSolved: 1 });
    expect(step.deltaCostUsd).toBeCloseTo(0.002, 6);
    expect(step.deltaCostPct).toBeCloseTo(100, 6);
    expect(step.solvedPerDollar).toBeCloseTo(500, 3);
  });

  it('3. compares width 2 -> 3, counting regressions', () => {
    const records = [
      rec('t1', 2, { success: true }), rec('t1', 3, { success: false }),
      rec('t2', 2, { success: false }), rec('t2', 3, { success: true }),
    ];
    const step = marginalSteps(records).find(s => s.from === 2)!;
    expect(step).toMatchObject({ pairedTasks: 2, newlySolved: 1, regressions: 1, netSolved: 0 });
  });

  it('4. compares width 3 -> 4 when the extra agent adds nothing', () => {
    const records = [rec('t1', 3), rec('t1', 4), rec('t2', 3), rec('t2', 4)];
    const step = marginalSteps(records).find(s => s.from === 3)!;
    expect(step).toMatchObject({ pairedTasks: 2, newlySolved: 0, netSolved: 0 });
    expect(step.deltaCostUsd).toBeCloseTo(0.002, 6);
    expect(step.solvedPerDollar).toBe(0);
  });

  it('5. finds each task\'s minimum successful width', () => {
    const records = [
      rec('easy', 1), rec('easy', 2), rec('easy', 3), rec('easy', 4),
      rec('mid', 1, { success: false }), rec('mid', 2, { success: false }), rec('mid', 3), rec('mid', 4),
    ];
    const min = minimumWidths(records);
    expect(min.byTask).toEqual([
      { workloadId: 'easy', minimumSuccessfulWidth: 1 },
      { workloadId: 'mid', minimumSuccessfulWidth: 3 },
    ]);
    expect(min.solvedAtWidth).toMatchObject({ 1: 1, 3: 1 });
  });

  it('6. records a task nobody solved', () => {
    const records = [1, 2, 3, 4].map(w => rec('hard', w as CrewWidth, { success: false }));
    const min = minimumWidths(records);
    expect(min.byTask[0].minimumSuccessfulWidth).toBeNull();
    expect(min.neverSolved).toBe(1);
  });

  it('7. detects a dominated wider crew', () => {
    // Same failure, more money, no faster: dominated.
    const records = [
      rec('t1', 1, { success: false, totalCostUsd: 0.001, workflowJctMs: 10_000 }),
      rec('t1', 2, { success: false, totalCostUsd: 0.002, workflowJctMs: 20_000 }),
      // Wider crew solves it: not dominated.
      rec('t2', 1, { success: false }), rec('t2', 2, { success: true }),
    ];
    const [step] = dominanceSteps(records);
    expect(step).toMatchObject({ pairedTasks: 2, dominated: 1 });
    expect(step.dominatedFraction).toBeCloseTo(0.5, 6);
  });

  it('8. counts equal outcomes achieved more cheaply by the narrower crew', () => {
    const records = [
      rec('t1', 1, { success: true, totalCostUsd: 0.001 }),
      rec('t1', 2, { success: true, totalCostUsd: 0.004 }),
    ];
    expect(dominanceSteps(records)[0].sameOutcomeCheaper).toBe(1);
  });

  it('9. computes the oracle minimum-width saving against always-4', () => {
    const records = [
      rec('easy', 1, { totalCostUsd: 0.001, totalTokens: 1000, workflowJctMs: 10_000 }),
      rec('easy', 4, { totalCostUsd: 0.004, totalTokens: 4000, workflowJctMs: 40_000 }),
      rec('hard', 1, { success: false, totalCostUsd: 0.001, totalTokens: 1000, workflowJctMs: 10_000 }),
      rec('hard', 4, { success: true, totalCostUsd: 0.004, totalTokens: 4000, workflowJctMs: 40_000 }),
    ];
    const o = oracleSavings(records);

    expect(o.tasksConsidered).toBe(2);
    expect(o.alwaysWidestCostUsd).toBeCloseTo(0.008, 6);
    // easy solved at width 1, hard needs width 4.
    expect(o.oracleCostUsd).toBeCloseTo(0.005, 6);
    expect(o.costSavedPct).toBeCloseTo(37.5, 4);
    expect(o.tokensSavedPct).toBeCloseTo(37.5, 4);
    expect(o.jctChangePct).toBeCloseTo(-37.5, 4);
    expect(o.oracleSolved).toBe(o.alwaysWidestSolved);
  });

  it('10. reports the active-agent fraction', () => {
    const records = [
      rec('t1', 4, { activeAgents: 2 }),
      rec('t2', 4, { activeAgents: 4 }),
    ];
    const [w4] = aggregateByWidth(records);
    expect(w4.meanActiveAgents).toBe(3);
    expect(w4.activeAgentFraction).toBeCloseTo(0.75, 6);
  });

  it('11. skips widths a task never ran at', () => {
    const records = [rec('t1', 1), rec('t1', 4), rec('t2', 1), rec('t2', 2)];
    const steps = marginalSteps(records);
    expect(steps.find(s => s.from === 1)?.pairedTasks).toBe(1); // only t2 has 1 and 2
    expect(steps.find(s => s.from === 2)).toBeUndefined();
    expect(byTask(records).get('t1')?.has(2)).toBe(false);
  });

  it('12. keeps failure reasons on failed runs', () => {
    const records = [rec('t1', 1, { success: false, failureReason: 'solution.py was never created' })];
    const analysis = analyzeCrewScaling(records, 'test');
    expect(analysis.widths[0].successRate).toBe(0);
    expect(records[0].failureReason).toContain('never created');
  });

  it('13. aggregates cost and tokens across runs', () => {
    const records = [
      rec('t1', 2, { totalCostUsd: 0.01, totalTokens: 5000 }),
      rec('t2', 2, { totalCostUsd: 0.03, totalTokens: 7000 }),
    ];
    const [w2] = aggregateByWidth(records);
    expect(w2.meanCostUsd).toBeCloseTo(0.02, 6);
    expect(w2.meanTokens).toBe(6000);
    // Nearest-rank p50 over two values takes the lower one.
    expect(w2.medianCostUsd).toBeCloseTo(0.01, 6);
  });

  it('14. reports mean JCT deltas for a width step', () => {
    const records = [
      rec('t1', 1, { workflowJctMs: 10_000 }), rec('t1', 2, { workflowJctMs: 14_000 }),
      rec('t2', 1, { workflowJctMs: 20_000 }), rec('t2', 2, { workflowJctMs: 26_000 }),
    ];
    const [step] = marginalSteps(records);
    expect(step.deltaJctMs).toBe(5000);
    expect(step.deltaJctPct).toBeCloseTo((5000 / 15_000) * 100, 6);
  });

  it('16. reports repeatability across repetitions of the same task', () => {
    const records = [
      // Stable: width 1 always works.
      ...[0, 1, 2].flatMap(seed => [rec('easy', 1, { seed }), rec('easy', 2, { seed })]),
      // Stable beneficiary: width 1 always fails, width 2 always works.
      ...[0, 1, 2].flatMap(seed => [rec('mid', 1, { seed, success: false }), rec('mid', 2, { seed })]),
      // Unstable: width 1 works on one repetition only.
      rec('flaky', 1, { seed: 0 }), rec('flaky', 1, { seed: 1, success: false }), rec('flaky', 1, { seed: 2, success: false }),
      rec('flaky', 2, { seed: 0 }), rec('flaky', 2, { seed: 1 }), rec('flaky', 2, { seed: 2 }),
    ];
    const rows = repeatability(records);

    const easy = rows.find(r => r.workloadId === 'easy')!;
    expect(easy.successesByWidth['1']).toEqual({ successes: 3, runs: 3 });
    expect(easy.minimumWidthPerSeed).toEqual([1, 1, 1]);
    expect(easy.stableMinimumWidth).toBe(true);
    expect(easy.deterministicOutcome).toBe(true);

    const mid = rows.find(r => r.workloadId === 'mid')!;
    expect(mid.successesByWidth['1']).toEqual({ successes: 0, runs: 3 });
    expect(mid.minimumWidthPerSeed).toEqual([2, 2, 2]);
    expect(mid.stableMinimumWidth).toBe(true);

    const flaky = rows.find(r => r.workloadId === 'flaky')!;
    expect(flaky.minimumWidthPerSeed).toEqual([1, 2, 2]);
    expect(flaky.stableMinimumWidth).toBe(false);
    expect(flaky.deterministicOutcome).toBe(false);

    expect(renderRepeatability(rows)).toContain('stable minimum width: 2/3');
  });

  it('17. marks a never-solved task as stable with no minimum width', () => {
    const records = [0, 1].flatMap(seed => [1, 2, 3, 4].map(w => rec('hard', w as CrewWidth, { seed, success: false })));
    const [row] = repeatability(records);
    expect(row.minimumWidthPerSeed).toEqual([null, null]);
    expect(row.stableMinimumWidth).toBe(true);
    expect(row.deterministicOutcome).toBe(true);
  });

  it('15. produces deterministic ordering and a stable report', () => {
    const records = [rec('zeta', 1), rec('alpha', 1), rec('alpha', 2), rec('zeta', 2)];
    expect([...byTask(records).keys()]).toEqual(['alpha', 'zeta']);

    const first = analyzeCrewScaling(records, 'test');
    const second = analyzeCrewScaling([...records].reverse(), 'test');
    expect(second.widths).toEqual(first.widths);
    expect(second.marginal).toEqual(first.marginal);
    expect(second.minimumWidth).toEqual(first.minimumWidth);

    const report = renderCrewScalingReport(first);
    expect(report).toContain('Crew-scaling characterization');
    expect(report).toContain('Minimum successful width');
    expect(report).toContain('Oracle elastic bound');
  });
});

// ── What each agent's row has to be able to explain ──────────────────

describe('agent contribution records', () => {
  /** An agent result shaped like the ones a crew run produces. */
  function agentResult(o: {
    status: string;
    error?: string;
    lifecycle?: AgentLifecycleEvent[];
    metrics?: Partial<LifecycleMetrics>;
  }): AgentResult {
    return {
      agentId: 'reviewer',
      role: 'Reviewer',
      taskResult: {
        id: 'r1', taskId: 't1', traceId: 'tr1',
        status: o.status,
        stepResults: [],
        completedAt: new Date().toISOString(),
        ...(o.error ? { error: o.error } : {}),
        ...(o.lifecycle ? { lifecycle: o.lifecycle } : {}),
        lifecycleMetrics: { modelCalls: 0, toolCalls: 0, ...o.metrics },
      },
      budgetUsed: { tokensUsed: 0, costUsd: 0 },
      blackboardWrites: [],
    } as unknown as AgentResult;
  }

  const evt = (
    from: AgentLifecycleState, to: AgentLifecycleState, timestamp: number,
    extra: Partial<AgentLifecycleEvent> = {},
  ): AgentLifecycleEvent => ({
    taskId: 't1', agentId: 'reviewer', from, to, timestamp, ...extra,
  });

  it('says why an agent that never ran did not run', () => {
    const row = contributionOf(agentResult({
      status: 'failed',
      error: 'Budget exhausted during direct execution\n    at execute (direct-executor.ts:157)',
      lifecycle: [evt('ready', 'failed', 3)],
    }));

    expect(row).toMatchObject({
      success: false,
      status: 'failed',
      // First line only: the reason, not the stack.
      error: 'Budget exhausted during direct execution',
      failedFrom: 'ready',
      modelCalls: 0,
      toolCalls: 0,
    });
  });

  it('distinguishes a specialist that read from one that wrote', () => {
    const row = contributionOf(agentResult({
      status: 'completed',
      metrics: { modelCalls: 2, toolCalls: 2 },
      lifecycle: [
        evt('ready', 'tool_wait', 0, { tool: 'file_read' }),
        evt('tool_wait', 'ready', 10, { tool: 'file_read', metadata: { ok: true } }),
        evt('ready', 'tool_wait', 20, { tool: 'file_write' }),
        evt('tool_wait', 'ready', 40, { tool: 'file_write', metadata: { ok: false, rolledBack: true } }),
        evt('ready', 'completed', 50),
      ],
    }));

    expect(row.tools?.map(t => t.tool)).toEqual(['file_read', 'file_write']);
    expect(row.tools?.[1]).toMatchObject({ ok: false, rolledBack: true });
  });

  it('leaves the failure fields off a clean run', () => {
    const row = contributionOf(agentResult({
      status: 'completed',
      lifecycle: [evt('ready', 'completed', 1)],
    }));

    expect(row.error).toBeUndefined();
    expect(row.failedFrom).toBeUndefined();
    expect(row.tools).toBeUndefined();
    expect(row.status).toBe('completed');
  });
});
