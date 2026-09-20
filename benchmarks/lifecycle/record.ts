/**
 * Turning Joule results into experiment records.
 *
 * The lifecycle events are the source of truth: tool-wait windows are
 * reconstructed from the transitions themselves rather than recomputed from
 * tool call durations, so what is measured is exactly what the runtime saw.
 */

import type { AgentLifecycleEvent, AgentLifecycleState, CrewResult, LifecycleMetrics, TaskResult } from '@joule/shared';
import type { AgentExecutionMode, AgentLifecycleRecord, LifecycleInterval, ToolCallRecord } from './types.js';

/** Longest failure message kept in an experiment artifact. */
const MAX_ERROR_CHARS = 300;

/**
 * A failure message, reduced to what an audit needs.
 *
 * Records are committed to the repository, so they take the first line only —
 * the reason, not the stack that produced it — and redact anything shaped like
 * a credential in case a provider echoed a request back in its error.
 */
export function sanitizeFailure(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split('\n')[0].trim();
  if (firstLine.length === 0) return undefined;
  const redacted = firstLine
    .replace(/\b(sk|pk|key|token|secret)-[A-Za-z0-9_-]{8,}/gi, '$1-[redacted]')
    .replace(/\b(Bearer|api[-_]?key["'\s:=]+)\s*[A-Za-z0-9_.-]{12,}/gi, '$1 [redacted]');
  return redacted.length > MAX_ERROR_CHARS ? `${redacted.slice(0, MAX_ERROR_CHARS)}…` : redacted;
}

/**
 * Every tool call in order, with the outcome the executor reported.
 *
 * A window is opened by the transition into `tool_wait` and closed by the
 * transition out of it; the closing event carries the outcome. A run cut short
 * mid-call leaves its window open, and an open window is reported with the
 * duration it is known to have lasted only if it closed — otherwise the call is
 * listed without one, because it has no measured end.
 */
export function toolCallSequence(events: readonly AgentLifecycleEvent[]): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  let open: { tool: string; start: number } | undefined;

  for (const e of events) {
    if (e.to === 'tool_wait') {
      open = { tool: e.tool ?? 'unknown', start: e.timestamp };
      continue;
    }
    if (open !== undefined && e.from === 'tool_wait') {
      const meta = e.metadata ?? {};
      out.push({
        tool: e.tool ?? open.tool,
        durationMs: Math.max(0, e.timestamp - open.start),
        ...(typeof meta.ok === 'boolean' ? { ok: meta.ok } : {}),
        ...(meta.rolledBack === true ? { rolledBack: true } : {}),
        ...(meta.error !== undefined ? { error: sanitizeFailure(meta.error) } : {}),
      });
      open = undefined;
    }
  }

  // A call still in flight when the events stop has no measured end and never
  // returned, so it is listed with no duration and as not having succeeded.
  if (open !== undefined) out.push({ tool: open.tool, durationMs: 0, ok: false });
  return out;
}

/** The state a failed run was in when it ended; `ready` means it never started. */
export function failureStage(events: readonly AgentLifecycleEvent[]): AgentLifecycleState | undefined {
  const last = events[events.length - 1];
  if (last === undefined || (last.to !== 'failed' && last.to !== 'cancelled')) return undefined;
  return last.from;
}

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
  /** `TaskResult.error` — the canonical reason a run did not complete */
  error?: string;
  lifecycle?: AgentLifecycleEvent[];
  lifecycleMetrics?: LifecycleMetrics;
  trajectory?: unknown;
}

export interface RecordOptions {
  runId: string;
  /** Benchmark problem or SWE-bench instance this run came from */
  workloadId?: string;
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
    ...(opts.workloadId ? { workloadId: opts.workloadId } : {}),
    ...(first.parentTaskId ? { parentTaskId: first.parentTaskId } : {}),
    agentId: first.agentId,
    ...(first.agentRole ? { agentRole: first.agentRole } : {}),
    executionMode: opts.executionMode ?? (result.trajectory ? 'full' : 'direct'),
    status: result.status,
    success: opts.success ?? result.status === 'completed',
    ...(sanitizeFailure(result.error) ? { error: sanitizeFailure(result.error) } : {}),
    ...(failureStage(events) ? { failedFrom: failureStage(events) } : {}),

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
    tools: toolCallSequence(events),

    lifecycleEvents: [...events],
  };
}

/**
 * One record per agent in a crew run.
 *
 * An agent that never reached an executor — rejected by a pre-flight check, or
 * failed by the orchestrator itself — has no lifecycle events and so no record
 * here. Its failure is still carried by the crew result's own agent entry.
 */
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
    error?: string;
    trajectory?: {
      taskId?: string;
      status?: string;
      error?: string;
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
        ...(task.error ?? trajectory.error ? { error: task.error ?? trajectory.error } : {}),
        lifecycle: trajectory.lifecycle,
        lifecycleMetrics: trajectory.lifecycleMetrics,
        trajectory,
      },
      { runId, executionMode: 'full', success: task.success, ...(task.workloadId ? { workloadId: task.workloadId } : {}) },
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
