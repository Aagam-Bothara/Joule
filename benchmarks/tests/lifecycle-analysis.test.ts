import { describe, it, expect } from 'vitest';
import type { AgentLifecycleEvent, AgentLifecycleState, LifecycleMetrics } from '@joule/shared';
import {
  activeInterval,
  intervalsInState,
  parseJsonl,
  recordsFromHarnessReport,
  toJsonl,
  toLifecycleRecord,
  toolWaitWindows,
} from '../lifecycle/record.js';
import {
  aggregateRecords,
  analyzeRecords,
  bucketToolWaits,
  concurrencyProfile,
  percentile,
  renderAgentBands,
  renderLifecycleReport,
  summarizeWorkflow,
  summarizeWorkflows,
} from '../lifecycle/analyze.js';
import type { AgentLifecycleRecord } from '../lifecycle/types.js';

// ── Builders ────────────────────────────────────────────────────────

interface Step { to: AgentLifecycleState; at: number; tool?: string; model?: string }

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
    expect(records[0]).toMatchObject({ runId: 'harness-live-mbpp-x', executionMode: 'full', success: true, taskId: 'task-9' });

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
