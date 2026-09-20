import { describe, it, expect } from 'vitest';
import type { AgentLifecycleEvent, AgentLifecycleState, LifecycleMetrics } from '@joule/shared';
import {
  activeInterval,
  failureStage,
  intervalsInState,
  parseJsonl,
  recordsFromHarnessReport,
  sanitizeFailure,
  toJsonl,
  toLifecycleRecord,
  toolCallSequence,
  toolWaitWindows,
} from '../lifecycle/record.js';
import {
  aggregateRecords,
  analyzeRecords,
  bucketToolWaits,
  concurrencyProfile,
  hideableWindows,
  percentile,
  pooledReclaimable,
  reclaimableToolWait,
  waitsOverThresholds,
  renderAgentBands,
  renderLifecycleReport,
  summarizeWorkflow,
  summarizeWorkflows,
} from '../lifecycle/analyze.js';
import type { AgentLifecycleRecord } from '../lifecycle/types.js';

// ── Builders ────────────────────────────────────────────────────────

interface Step { to: AgentLifecycleState; at: number; tool?: string; model?: string; metadata?: Record<string, unknown> }

interface Identity { taskId?: string; parentTaskId?: string; agentRole?: string }

function events(agentId: string, steps: Step[], id: Identity = {}): AgentLifecycleEvent[] {
  let from: AgentLifecycleState = 'ready';
  return steps.map(s => {
    const event: AgentLifecycleEvent = {
      taskId: id.taskId ?? `task-${agentId}`,
      agentId,
      ...(id.parentTaskId ? { parentTaskId: id.parentTaskId } : {}),
      ...(id.agentRole ? { agentRole: id.agentRole } : {}),
      from,
      to: s.to,
      timestamp: s.at,
      ...(s.tool ? { tool: s.tool } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.metadata ? { metadata: s.metadata } : {}),
    };
    from = s.to;
    return event;
  });
}

/**
 * Metrics as the runtime reports them. Built here from the same intervals the
 * runtime derives them from — the runtime's own helper is covered by the core
 * lifecycle tests, and this keeps the benchmarks project free of runtime deps.
 */
function metricsFrom(evs: AgentLifecycleEvent[]): LifecycleMetrics {
  const spanOf = (state: AgentLifecycleState): number =>
    intervalsInState(evs, state).reduce((sum, i) => sum + (i.end - i.start), 0);
  const waits = toolWaitWindows(evs);
  const totalRuntimeMs = evs[evs.length - 1].timestamp - evs[0].timestamp;
  const toolWaitMs = spanOf('tool_wait');
  const modelRuntimeMs = spanOf('model_running');
  return {
    totalRuntimeMs,
    modelRuntimeMs,
    toolWaitMs,
    idleFraction: totalRuntimeMs > 0 ? toolWaitMs / totalRuntimeMs : 0,
    otherMs: totalRuntimeMs - modelRuntimeMs - toolWaitMs,
    modelCalls: evs.filter(e => e.to === 'model_running').length,
    toolCalls: evs.filter(e => e.to === 'tool_wait').length,
    avgToolWaitMs: waits.length > 0 ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
    p95ToolWaitMs: percentile(waits, 0.95),
    finalState: evs[evs.length - 1].to,
  };
}

function record(agentId: string, steps: Step[], id: Identity = {}, status = 'completed'): AgentLifecycleRecord {
  const evs = events(agentId, steps, id);
  const rec = toLifecycleRecord(
    { taskId: evs[0].taskId, status, lifecycle: evs, lifecycleMetrics: metricsFrom(evs) },
    { runId: 'run-1' },
  );
  if (!rec) throw new Error('record builder produced nothing');
  return rec;
}

/** model 0-100, tool 110-310, model 320-400, done 410. */
const AGENT_STEPS: Step[] = [
  { to: 'model_running', at: 0 },
  { to: 'ready', at: 100, model: 'qwen2.5' },
  { to: 'tool_wait', at: 110, tool: 'shell_exec' },
  { to: 'ready', at: 310, tool: 'shell_exec' },
  { to: 'model_running', at: 320 },
  { to: 'ready', at: 400, model: 'qwen2.5' },
  { to: 'completed', at: 410 },
];

// ── Tool-wait windows ───────────────────────────────────────────────

describe('tool-wait windows', () => {
  it('reconstructs every contiguous window from the events', () => {
    const evs = events('a', [
      { to: 'tool_wait', at: 2100, tool: 'shell_exec' },
      { to: 'ready', at: 7800, tool: 'shell_exec' },
      { to: 'tool_wait', at: 8000, tool: 'file_read' },
      { to: 'ready', at: 8050, tool: 'file_read' },
      { to: 'completed', at: 8060 },
    ]);
    expect(toolWaitWindows(evs)).toEqual([5700, 50]);
    expect(intervalsInState(evs, 'tool_wait')).toEqual([
      { start: 2100, end: 7800 },
      { start: 8000, end: 8050 },
    ]);
  });

  it('counts a window the run died inside, and ignores one never closed', () => {
    const failedInside = events('a', [
      { to: 'tool_wait', at: 100, tool: 'shell_exec' },
      { to: 'failed', at: 400 },
    ]);
    expect(toolWaitWindows(failedInside)).toEqual([300]);

    const neverClosed = events('a', [{ to: 'tool_wait', at: 100, tool: 'shell_exec' }]);
    expect(toolWaitWindows(neverClosed)).toEqual([]);
  });

  it('reports the agent span from first to last transition', () => {
    expect(activeInterval(events('a', AGENT_STEPS))).toEqual({ start: 0, end: 410 });
    expect(activeInterval([])).toBeUndefined();
  });
});

// ── Records ─────────────────────────────────────────────────────────

describe('experiment records', () => {
  it('carries identity, mode and the tool-wait distribution', () => {
    const r = record('agent_reviewer', AGENT_STEPS, {
      taskId: 'agent-task-1', parentTaskId: 'task-root', agentRole: 'reviewer',
    });

    expect(r).toMatchObject({
      runId: 'run-1',
      taskId: 'agent-task-1',
      parentTaskId: 'task-root',
      agentId: 'agent_reviewer',
      agentRole: 'reviewer',
      executionMode: 'direct', // no trajectory on the source result
      success: true,
      modelCalls: 2,
      toolCalls: 1,
    });
    expect(r.toolWaitDurationsMs).toEqual([200]);
    expect(r.maxToolWaitMs).toBe(200);
    expect(r.minToolWaitMs).toBe(200);
    expect(r.modelRuntimeMs).toBe(180);
    expect(r.toolWaitMs).toBe(200);
    expect(r.totalRuntimeMs).toBe(410);
    expect(r.idleFraction).toBeCloseTo(200 / 410, 6);
  });

  it('keeps the tool sequence, with the outcome of each call', () => {
    const r = record('agent_reviewer', [
      { to: 'tool_wait', at: 0, tool: 'file_read' },
      { to: 'ready', at: 50, tool: 'file_read', metadata: { ok: true } },
      { to: 'tool_wait', at: 60, tool: 'file_write' },
      { to: 'ready', at: 90, tool: 'file_write', metadata: { ok: false, rolledBack: true } },
      { to: 'tool_wait', at: 100, tool: 'shell_exec' },
      { to: 'ready', at: 180, tool: 'shell_exec', metadata: { ok: false, error: 'exit 1\n  at frame' } },
      { to: 'completed', at: 200 },
    ]);

    // The question the counts could not answer: did this agent read, or write?
    expect(r.tools.map(t => t.tool)).toEqual(['file_read', 'file_write', 'shell_exec']);
    expect(r.tools[0]).toMatchObject({ ok: true, durationMs: 50 });
    expect(r.tools[1]).toMatchObject({ ok: false, rolledBack: true });
    // The stack is dropped; the reason is kept.
    expect(r.tools[2].error).toBe('exit 1');
  });

  it('records a tool call the run died inside', () => {
    // Failing out of a tool closes the window, so the wait is still measured.
    expect(toolCallSequence(events('a', [
      { to: 'tool_wait', at: 0, tool: 'shell_exec' },
      { to: 'failed', at: 90 },
    ]))).toEqual([{ tool: 'shell_exec', durationMs: 90 }]);

    // A stream that simply stops mid-call has no measured end; the call is
    // still listed, because which tool was in flight is the evidence.
    expect(toolCallSequence(events('a', [
      { to: 'tool_wait', at: 0, tool: 'shell_exec' },
    ]))).toEqual([{ tool: 'shell_exec', durationMs: 0, ok: false }]);
  });

  it('keeps why a run failed and how far it got', () => {
    // The shape that made fifteen crew agents unexplainable: no calls, no
    // tools, just a terminal failure.
    const evs = events('agent_tester', [{ to: 'failed', at: 5 }]);
    const r = toLifecycleRecord(
      { taskId: 't', status: 'failed', error: 'Budget exhausted during direct execution', lifecycle: evs, lifecycleMetrics: metricsFrom(evs) },
      { runId: 'run-1' },
    )!;

    expect(r).toMatchObject({
      success: false,
      status: 'failed',
      error: 'Budget exhausted during direct execution',
      failedFrom: 'ready', // never reached a model or a tool
    });
    expect(r.modelCalls).toBe(0);
    expect(r.tools).toEqual([]);
  });

  it('leaves a completed run with no failure fields', () => {
    const r = record('agent_ok', AGENT_STEPS);
    expect(r.error).toBeUndefined();
    expect(r.failedFrom).toBeUndefined();
    expect(failureStage(events('a', AGENT_STEPS))).toBeUndefined();
  });

  it('reduces a failure message to its reason', () => {
    expect(sanitizeFailure(new Error('LLM call failed\n    at chat (openai.ts:1)'))).toBe('LLM call failed');
    expect(sanitizeFailure('401 unauthorized for key sk-or-v1-abcdef0123456789'))
      .toBe('401 unauthorized for key sk-[redacted]');
    expect(sanitizeFailure('Bearer abcdefghijklmnop rejected')).toBe('Bearer [redacted] rejected');
    expect(sanitizeFailure('x'.repeat(400))).toHaveLength(301);
    expect(sanitizeFailure(undefined)).toBeUndefined();
    expect(sanitizeFailure('   ')).toBeUndefined();
  });

  it('skips results without lifecycle instrumentation', () => {
    expect(toLifecycleRecord({ taskId: 't', status: 'completed' }, { runId: 'r' })).toBeUndefined();
    expect(toLifecycleRecord({ taskId: 't', status: 'completed', lifecycle: [] }, { runId: 'r' })).toBeUndefined();
  });

  it('reads records out of a harness report and round-trips through JSONL', () => {
    const evs = events('agent_1', AGENT_STEPS, { taskId: 'task-9' });
    const report = {
      tasks: [
        { workloadId: 'mbpp-1', status: 'completed', success: true, trajectory: { taskId: 'task-9', lifecycle: evs, lifecycleMetrics: metricsFrom(evs) } },
        { workloadId: 'mbpp-2', status: 'failed', success: false },
      ],
    };

    const records = recordsFromHarnessReport(report, 'harness-live-mbpp-x');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ runId: 'harness-live-mbpp-x', executionMode: 'full', success: true, taskId: 'task-9', workloadId: 'mbpp-1' });

    expect(parseJsonl<AgentLifecycleRecord>(toJsonl(records))).toEqual(records);
    expect(toJsonl([])).toBe('');
  });
});

// ── Statistics ──────────────────────────────────────────────────────

describe('statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.9)).toBe(90);
    expect(percentile(values, 0.95)).toBe(100);
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([42], 0.95)).toBe(42);
  });

  it('counts waits above each reported threshold', () => {
    const shares = waitsOverThresholds([100, 600, 1500, 3000, 7000, 12_000]);
    expect(shares.map(s => [s.thresholdMs, s.count])).toEqual([
      [500, 5], [1000, 4], [2000, 3], [5000, 2], [10_000, 1],
    ]);
    expect(shares[0].fraction).toBeCloseTo(5 / 6, 6);
    expect(waitsOverThresholds([]).every(s => s.count === 0 && s.fraction === 0)).toBe(true);
  });

  it('computes hideable time for hypothetical overheads', () => {
    // 2s + 300ms + 50ms = 2350ms of measured wait.
    const h = hideableWindows([2000, 300, 50], [100, 250, 500, 1000, 2000]);

    expect(h[0]).toMatchObject({ migrationCostMs: 100, eligibleWaits: 2 });
    // (2000-100) + (300-100) = 2100 of 2350
    expect(h[0].hideableMs).toBe(2100);
    expect(h[0].hideableFraction).toBeCloseTo(2100 / 2350, 6);
    expect(h[0].eligibleFraction).toBeCloseTo(2 / 3, 6);

    // At 1s only the 2s wait qualifies; at 2s nothing is strictly longer.
    expect(h[3]).toMatchObject({ eligibleWaits: 1, hideableMs: 1000 });
    expect(h[4]).toMatchObject({ eligibleWaits: 0, hideableMs: 0, hideableFraction: 0 });

    const empty = hideableWindows([]);
    expect(empty.every(x => x.eligibleWaits === 0 && x.hideableFraction === 0)).toBe(true);
  });

  it('buckets tool-wait windows by duration', () => {
    const durations = [50, 99, 100, 400, 500, 999, 1000, 1999, 2000, 4999, 5000, 9999, 10_000, 60_000];
    const buckets = bucketToolWaits(durations);

    expect(buckets.map(b => [b.label, b.count])).toEqual([
      ['<100ms', 2], ['100-500ms', 2], ['500ms-1s', 2], ['1-2s', 2],
      ['2-5s', 2], ['5-10s', 2], ['10s+', 2],
    ]);
    expect(buckets.every(b => Math.abs(b.percentage - 2 / 14) < 1e-9)).toBe(true);
    expect(bucketToolWaits([]).every(b => b.count === 0 && b.percentage === 0)).toBe(true);
  });
});

// ── Concurrency ─────────────────────────────────────────────────────

describe('concurrency sweep', () => {
  it('does not count intervals that merely touch', () => {
    const p = concurrencyProfile([{ start: 0, end: 10 }, { start: 10, end: 20 }], 20);
    expect(p.max).toBe(1);
    expect(p.overlapMs).toBe(0);
    expect(p.avg).toBe(1); // busy the whole window, one at a time
  });

  it('measures peak, time-weighted average and overlap', () => {
    const p = concurrencyProfile([{ start: 0, end: 10 }, { start: 5, end: 15 }], 20);
    expect(p.max).toBe(2);
    expect(p.overlapMs).toBe(5);
    expect(p.avg).toBeCloseTo(20 / 20, 6); // 10ms + 10ms of agent-time over a 20ms window
  });

  it('handles nesting and empty input', () => {
    const nested = concurrencyProfile([{ start: 0, end: 20 }, { start: 5, end: 10 }, { start: 6, end: 8 }], 20);
    expect(nested.max).toBe(3);
    expect(nested.overlapMs).toBe(5); // 5..10 has 2+, of which 6..8 has 3

    const empty = concurrencyProfile([], 100);
    expect(empty).toEqual({ max: 0, avg: 0, overlapMs: 0 });
    expect(concurrencyProfile([{ start: 5, end: 5 }], 100).max).toBe(0);
  });
});

// ── Reclaimable tool wait ───────────────────────────────────────────

describe('reclaimable tool wait', () => {
  /** A waits 100-1100; B runs a model 600-900 inside that wait. */
  const pair = (): AgentLifecycleRecord[] => [
    record('agent_a', [
      { to: 'tool_wait', at: 100, tool: 'shell_exec' },
      { to: 'ready', at: 1100 },
      { to: 'completed', at: 1100 },
    ], { parentTaskId: 'w1', taskId: 'a' }),
    record('agent_b', [
      { to: 'model_running', at: 600 },
      { to: 'ready', at: 900 },
      { to: 'completed', at: 1000 },
    ], { parentTaskId: 'w1', taskId: 'b' }),
  ];

  it('counts only the part of a wait that overlaps another agent needing the model', () => {
    const r = reclaimableToolWait(pair());
    expect(r.totalToolWaitMs).toBe(1000);
    expect(r.reclaimableToolWaitMs).toBe(300);
    expect(r.reclaimableFraction).toBeCloseTo(0.3, 6);
    expect(r.isolatedToolWaitMs).toBe(700);
  });

  it('charges a start-up cost from the beginning of each wait', () => {
    const r = reclaimableToolWait(pair(), [100, 500, 1000]);
    // The overlap sits at 600-900, so a 100ms or 500ms cost still leaves all of it.
    expect(r.afterCost[0]).toMatchObject({ migrationCostMs: 100, reclaimableMs: 300 });
    expect(r.afterCost[1]).toMatchObject({ migrationCostMs: 500, reclaimableMs: 300 });
    // A 1000ms cost starts at t=1100, when the wait is already over.
    expect(r.afterCost[2]).toMatchObject({ migrationCostMs: 1000, reclaimableMs: 0 });
  });

  it('ignores the waiting agent\'s own model time and non-overlapping demand', () => {
    const solo = [record('agent_a', [
      { to: 'model_running', at: 0 },
      { to: 'ready', at: 100 },
      { to: 'tool_wait', at: 100, tool: 'shell_exec' },
      { to: 'ready', at: 900 },
      { to: 'completed', at: 900 },
    ], { parentTaskId: 'w1', taskId: 'a' })];
    expect(reclaimableToolWait(solo).reclaimableToolWaitMs).toBe(0);

    const disjoint = [
      record('agent_a', [
        { to: 'tool_wait', at: 0, tool: 'shell_exec' },
        { to: 'ready', at: 500 },
        { to: 'completed', at: 500 },
      ], { parentTaskId: 'w1', taskId: 'a' }),
      record('agent_b', [
        { to: 'model_running', at: 600 },
        { to: 'ready', at: 900 },
        { to: 'completed', at: 900 },
      ], { parentTaskId: 'w1', taskId: 'b' }),
    ];
    const r = reclaimableToolWait(disjoint);
    expect(r.reclaimableToolWaitMs).toBe(0);
    expect(r.isolatedToolWaitMs).toBe(500);
  });

  it('merges several agents\' demand without double counting', () => {
    const many = [
      ...pair(),
      record('agent_c', [
        { to: 'model_running', at: 700 },   // overlaps b's window
        { to: 'ready', at: 1000 },
        { to: 'completed', at: 1000 },
      ], { parentTaskId: 'w1', taskId: 'c' }),
    ];
    // b covers 600-900, c covers 700-1000 -> union 600-1000 inside a's wait.
    expect(reclaimableToolWait(many).reclaimableToolWaitMs).toBe(400);
  });

  it('pools per workflow so unrelated agents never overlap', () => {
    const w1 = pair();
    const w2 = pair().map(r => ({ ...r, parentTaskId: 'w2', taskId: `${r.taskId}2` }));
    const pooled = pooledReclaimable([...w1, ...w2]);
    expect(pooled.totalToolWaitMs).toBe(2000);
    expect(pooled.reclaimableToolWaitMs).toBe(600);
    expect(pooled.reclaimableFraction).toBeCloseTo(0.3, 6);
  });
});

// ── Workflows ───────────────────────────────────────────────────────

describe('workflow summaries', () => {
  /** Three crew agents under one parent, with two overlapping model calls. */
  const crew = (): AgentLifecycleRecord[] => [
    record('agent_a', [
      { to: 'model_running', at: 0 },
      { to: 'ready', at: 100 },
      { to: 'tool_wait', at: 100, tool: 'shell_exec' },
      { to: 'ready', at: 500 },
      { to: 'completed', at: 500 },
    ], { parentTaskId: 'task-root', taskId: 'agent-task-a', agentRole: 'researcher' }),
    record('agent_b', [
      { to: 'model_running', at: 50 },
      { to: 'ready', at: 150 },
      { to: 'completed', at: 200 },
    ], { parentTaskId: 'task-root', taskId: 'agent-task-b', agentRole: 'implementer' }),
    record('agent_c', [
      { to: 'model_running', at: 600 },
      { to: 'ready', at: 700 },
      { to: 'completed', at: 800 },
    ], { parentTaskId: 'task-root', taskId: 'agent-task-c', agentRole: 'reviewer' }),
  ];

  it('computes wall clock, concurrency and model-demand overlap', () => {
    const summary = summarizeWorkflow(crew())!;

    expect(summary.parentTaskId).toBe('task-root');
    expect(summary.agentCount).toBe(3);
    expect(summary.wallClockRuntimeMs).toBe(800);
    // Each agent's own span: a 0-500, b 50-200, c 600-800.
    expect(summary.totalAgentRuntimeMs).toBe(500 + 150 + 200);

    // a and b overlap from 50 to 200; c runs alone afterwards.
    expect(summary.maxConcurrentAgents).toBe(2);
    expect(summary.avgConcurrentAgents).toBeCloseTo(850 / 800, 6);

    // model_running: a 0-100, b 50-150, c 600-700 -> 50..100 has two.
    expect(summary.maxConcurrentModelRunning).toBe(2);
    expect(summary.modelDemandOverlapMs).toBe(50);
    expect(summary.modelDemandOverlapFraction).toBeCloseTo(50 / 800, 6);
    expect(summary.avgConcurrentModelRunning).toBeCloseTo(300 / 800, 6);

    // Only agent_a waits on a tool.
    expect(summary.maxConcurrentToolWait).toBe(1);
    expect(summary.avgConcurrentToolWait).toBeCloseTo(400 / 800, 6);
  });

  it('treats a standalone task as its own workflow', () => {
    const standalone = [
      record('agent_x', AGENT_STEPS, { taskId: 'task-1' }),
      record('agent_y', AGENT_STEPS, { taskId: 'task-2' }),
    ];
    const summaries = summarizeWorkflows(standalone);

    expect(summaries).toHaveLength(2);
    expect(summaries.map(s => s.parentTaskId).sort()).toEqual(['task-1', 'task-2']);
    expect(summaries[0].agentCount).toBe(1);
    expect(summaries[0].modelDemandOverlapMs).toBe(0);
    expect(summaries[0].modelDemandOverlapFraction).toBe(0);
  });

  it('groups crew agents and standalone tasks separately', () => {
    expect(summarizeWorkflows([...crew(), record('agent_z', AGENT_STEPS, { taskId: 'task-solo' })])).toHaveLength(2);
  });
});

// ── Aggregate and report ────────────────────────────────────────────

describe('aggregate', () => {
  const records = [
    record('agent_a', AGENT_STEPS, { parentTaskId: 'task-root', taskId: 'agent-task-a' }),
    record('agent_b', AGENT_STEPS, { parentTaskId: 'task-root', taskId: 'agent-task-b' }, 'failed'),
    record('agent_c', AGENT_STEPS, { taskId: 'task-solo' }),
  ];

  it('summarizes runs, agents, workflows and totals', () => {
    const a = aggregateRecords(records);

    expect(a.runs).toBe(3);
    expect(a.agents).toBe(3);
    expect(a.workflows).toBe(2);
    expect(a.successRate).toBeCloseTo(2 / 3, 6);
    expect(a.totals.modelRuntimeMs).toBe(3 * 180);
    expect(a.totals.toolWaitMs).toBe(3 * 200);
    expect(a.totals.toolCalls).toBe(3);
    expect(a.toolWaitMs.count).toBe(3);
    expect(a.toolWaitMs.median).toBe(200);
    expect(a.idleFraction.median).toBeCloseTo(200 / 410, 6);
    expect(a.buckets.find(b => b.label === '100-500ms')!.count).toBe(3);
    expect(a.byMode).toHaveLength(1);
    expect(a.byMode[0]).toMatchObject({ executionMode: 'direct', runs: 3, toolWaitWindows: 3 });
  });

  it('handles an empty dataset', () => {
    const a = aggregateRecords([]);
    expect(a).toMatchObject({ runs: 0, agents: 0, workflows: 0, successRate: 0 });
    expect(a.toolWaitMs.count).toBe(0);
    expect(Number.isFinite(a.idleFraction.mean)).toBe(true);
    expect(renderLifecycleReport(analyzeRecords([], 'none'))).toContain('No lifecycle records found.');
  });

  it('renders agent bands on a shared time axis', () => {
    // a: model 0-100 then tool 100-200. b: starts halfway, model 100-200.
    const a = record('agent_a', [
      { to: 'model_running', at: 0 },
      { to: 'ready', at: 100 },
      { to: 'tool_wait', at: 100, tool: 'shell_exec' },
      { to: 'ready', at: 200 },
      { to: 'completed', at: 200 },
    ], { parentTaskId: 'task-root', taskId: 'a', agentRole: 'researcher' });
    const b = record('agent_b', [
      { to: 'model_running', at: 100 },
      { to: 'ready', at: 200 },
      { to: 'completed', at: 200 },
    ], { parentTaskId: 'task-root', taskId: 'b', agentRole: 'reviewer' });

    const bands = renderAgentBands([a, b], 10).split('\n');
    expect(bands[0]).toContain('researcher');
    expect(bands[0]).toMatch(/\|#{5}-{5}\|/);
    // The later agent's band is blank until it starts, then all model.
    expect(bands[1]).toMatch(/\| {5}#{5}\|/);
    expect(renderAgentBands([], 10)).toBe('(no lifecycle events)');
  });

  it('renders a human-readable report', () => {
    const out = renderLifecycleReport(analyzeRecords(records, 'runs.jsonl'));

    expect(out).toContain('Joule Lifecycle Characterization');
    expect(out).toMatch(/Runs:\s+3/);
    expect(out).toMatch(/Parent workflows:\s+2/);
    expect(out).toContain('Individual tool-wait windows (n=3)');
    expect(out).toContain('100-500ms');
    expect(out).toContain('model demand overlap');
    expect(out).toMatch(/direct\s+runs\s+3/);
  });
});
