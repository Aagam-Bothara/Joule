/**
 * Turning Joule results into experiment records.
 *
 * The lifecycle events are the source of truth: tool-wait windows are
 * reconstructed from the transitions themselves rather than recomputed from
 * tool call durations, so what is measured is exactly what the runtime saw.
 */

import type { AgentLifecycleEvent, AgentLifecycleState, CrewResult, LifecycleMetrics, TaskResult } from '@joule/shared';
import type { AgentExecutionMode, AgentLifecycleRecord, LifecycleInterval } from './types.js';

/** Every contiguous interval the agent spent in `state`. */
export function intervalsInState(events: readonly AgentLifecycleEvent[], state: AgentLifecycleState): LifecycleInterval[] {
  const out: LifecycleInterval[] = [];
  let openedAt: number | undefined;
  for (const e of events) {
    if (e.to === state) {
      openedAt = e.timestamp;
      continue;
    }
    if (openedAt !== undefined && e.from === state) {
      out.push({ start: openedAt, end: e.timestamp });
      openedAt = undefined;
    }
  }
  // A run cut short inside a state leaves its last window open; it has no
  // measured end, so it is not counted rather than guessed at.
  return out;
}

/** Duration of every individual tool_wait window, in order. */
export function toolWaitWindows(events: readonly AgentLifecycleEvent[]): number[] {
  return intervalsInState(events, 'tool_wait').map(i => Math.max(0, i.end - i.start));
}

/** The span an agent was alive: first transition to last. */
export function activeInterval(events: readonly AgentLifecycleEvent[]): LifecycleInterval | undefined {
  if (events.length === 0) return undefined;
  return { start: events[0].timestamp, end: events[events.length - 1].timestamp };
}

/** A result carrying lifecycle instrumentation, from either executor. */
export interface LifecycleSource {
  taskId: string;
  status: string;
  lifecycle?: AgentLifecycleEvent[];
  lifecycleMetrics?: LifecycleMetrics;
  trajectory?: unknown;
}

export interface RecordOptions {
  runId: string;
  /** Defaults to 'full' when the result carries a trajectory, else 'direct' */
  executionMode?: AgentExecutionMode;
  /** Defaults to status === 'completed' */
  success?: boolean;
}

/**
 * One record from one result. Returns undefined when the result predates
 * lifecycle instrumentation or produced no events.
 */
export function toLifecycleRecord(result: LifecycleSource, opts: RecordOptions): AgentLifecycleRecord | undefined {
  const events = result.lifecycle ?? [];
  const metrics = result.lifecycleMetrics;
  if (events.length === 0 || !metrics) return undefined;

  const waits = toolWaitWindows(events);
  const first = events[0];
  return {
    runId: opts.runId,
    taskId: first.taskId ?? result.taskId,
    ...(first.parentTaskId ? { parentTaskId: first.parentTaskId } : {}),
    agentId: first.agentId,
    ...(first.agentRole ? { agentRole: first.agentRole } : {}),
    executionMode: opts.executionMode ?? (result.trajectory ? 'full' : 'direct'),
    status: result.status,
    success: opts.success ?? result.status === 'completed',

    totalRuntimeMs: metrics.totalRuntimeMs,
    modelRuntimeMs: metrics.modelRuntimeMs,
    toolWaitMs: metrics.toolWaitMs,
    otherMs: metrics.otherMs,
    idleFraction: metrics.idleFraction,

    modelCalls: metrics.modelCalls,
    toolCalls: metrics.toolCalls,

    avgToolWaitMs: metrics.avgToolWaitMs,
    p95ToolWaitMs: metrics.p95ToolWaitMs,
    maxToolWaitMs: waits.length > 0 ? Math.max(...waits) : 0,
    minToolWaitMs: waits.length > 0 ? Math.min(...waits) : 0,
    toolWaitDurationsMs: waits,

    lifecycleEvents: [...events],
  };
}

/** One record per agent in a crew run. */
export function recordsFromCrewResult(crew: CrewResult, runId: string): AgentLifecycleRecord[] {
  const out: AgentLifecycleRecord[] = [];
  for (const agentResult of crew.agentResults) {
    const record = toLifecycleRecord(agentResult.taskResult as LifecycleSource, { runId });
    if (record) out.push(record);
  }
  return out;
}

/** One record from a single task run. */
export function recordFromTaskResult(result: TaskResult, runId: string): AgentLifecycleRecord | undefined {
  return toLifecycleRecord(result as LifecycleSource, { runId });
}

/** A benchmark-harness report, seen only through what this analysis needs. */
interface HarnessReportShape {
  timestamp?: string;
  workload?: string;
  tasks?: Array<{
    workloadId?: string;
    strategy?: string;
    status?: string;
    success?: boolean;
    trajectory?: {
      taskId?: string;
      status?: string;
      lifecycle?: AgentLifecycleEvent[];
      lifecycleMetrics?: LifecycleMetrics;
    };
  }>;
}

/**
 * Records from a harness report file. Every task in one report ran in one
 * process, so their timestamps are comparable with each other.
 */
export function recordsFromHarnessReport(report: unknown, runId: string): AgentLifecycleRecord[] {
  const shape = report as HarnessReportShape;
  const out: AgentLifecycleRecord[] = [];
  for (const task of shape.tasks ?? []) {
    const trajectory = task.trajectory;
    if (!trajectory?.lifecycle || !trajectory.lifecycleMetrics) continue;
    const record = toLifecycleRecord(
      {
        taskId: trajectory.taskId ?? task.workloadId ?? 'unknown',
        status: task.status ?? trajectory.status ?? 'unknown',
        lifecycle: trajectory.lifecycle,
        lifecycleMetrics: trajectory.lifecycleMetrics,
        trajectory,
      },
      { runId, executionMode: 'full', success: task.success },
    );
    if (record) out.push(record);
  }
  return out;
}

// ── JSONL ────────────────────────────────────────────────────────────

export function toJsonl(records: readonly AgentLifecycleRecord[]): string {
  return records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as T);
}
