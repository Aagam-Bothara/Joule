/**
 * Agent lifecycle tracking — instrumentation only.
 *
 * `AgentLifecycleTracker` records when a run is thinking, waiting on a tool, or
 * finished, and refuses transitions the lifecycle does not allow (a terminal
 * state never reopens). Every transition is also logged to the trace as an
 * `agent_lifecycle` event, so a persisted trace can be replayed without the
 * tracker.
 *
 * Nothing here influences execution: the executor calls it around the awaits it
 * already makes, and errors keep propagating exactly as before.
 */

import {
  canTransitionLifecycle,
  generateId,
  isTerminalLifecycleState,
  monotonicNow,
  type AgentLifecycleEvent,
  type AgentLifecycleReason,
  type AgentLifecycleState,
  type LifecycleMetrics,
} from '@joule/shared';
import type { TraceLogger } from '../trace-logger.js';

/** A transition the lifecycle does not allow, e.g. `completed -> ready`. */
export class LifecycleTransitionError extends Error {
  constructor(
    readonly from: AgentLifecycleState,
    readonly to: AgentLifecycleState,
  ) {
    super(`Invalid agent lifecycle transition: ${from} -> ${to}`);
    this.name = 'LifecycleTransitionError';
  }
}

export interface LifecycleTrackerOptions {
  taskId: string;
  /**
   * The agent this tracker follows. Defaults to a fresh id, so two agents on
   * the same task never share one; crews pass their own `agent.id`.
   */
  agentId?: string;
  /** Task this run was spawned from (crew agent tasks, sub-tasks) */
  parentTaskId?: string;
  /** Crew role, carried on every event for grouping */
  agentRole?: string;
  /** When given, every transition is also logged as an `agent_lifecycle` trace event */
  tracer?: TraceLogger;
  traceId?: string;
  /** Clock, injectable for tests */
  now?: () => number;
}

/** Extra detail carried on a transition. */
export interface LifecycleTransitionDetail {
  model?: string;
  tool?: string;
  metadata?: Record<string, unknown>;
}

export class AgentLifecycleTracker {
  readonly taskId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly agentRole?: string;
  /** When the agent entered `ready`, on the monotonic clock */
  readonly startTime: number;

  private readonly log: AgentLifecycleEvent[] = [];
  private readonly tracer?: TraceLogger;
  private readonly traceId?: string;
  private readonly clock: () => number;
  private state: AgentLifecycleState = 'ready';

  constructor(opts: LifecycleTrackerOptions) {
    this.taskId = opts.taskId;
    this.agentId = opts.agentId ?? generateId('agent');
    this.parentTaskId = opts.parentTaskId;
    this.agentRole = opts.agentRole;
    this.tracer = opts.tracer;
    this.traceId = opts.traceId;
    this.clock = opts.now ?? monotonicNow;
    this.startTime = this.clock();
  }

  /** The state the agent is in right now. */
  get current(): AgentLifecycleState {
    return this.state;
  }

  /** Transitions so far, oldest first. */
  get events(): AgentLifecycleEvent[] {
    return [...this.log];
  }

  isTerminal(): boolean {
    return isTerminalLifecycleState(this.state);
  }

  /** Record a transition. Throws `LifecycleTransitionError` if it is not allowed. */
  transition(to: AgentLifecycleState, reason?: AgentLifecycleReason, detail: LifecycleTransitionDetail = {}): AgentLifecycleEvent {
    if (!canTransitionLifecycle(this.state, to)) throw new LifecycleTransitionError(this.state, to);
    const event: AgentLifecycleEvent = {
      taskId: this.taskId,
      agentId: this.agentId,
      ...(this.parentTaskId ? { parentTaskId: this.parentTaskId } : {}),
      ...(this.agentRole ? { agentRole: this.agentRole } : {}),
      from: this.state,
      to,
      timestamp: this.clock(),
      ...(reason ? { reason } : {}),
      ...(detail.model ? { model: detail.model } : {}),
      ...(detail.tool ? { tool: detail.tool } : {}),
      ...(detail.metadata ? { metadata: detail.metadata } : {}),
    };
    this.state = to;
    this.log.push(event);
    if (this.tracer && this.traceId) {
      this.tracer.logEvent(this.traceId, 'agent_lifecycle', { ...event });
    }
    return event;
  }

  modelStart(model?: string, metadata?: Record<string, unknown>): AgentLifecycleEvent {
    return this.transition('model_running', 'model_start', { model, metadata });
  }

  /**
   * The model call returned. A call that threw also ends here — the run
   * continues, so the agent is `ready` again; pass the error in `metadata`.
   */
  modelEnd(model?: string, metadata?: Record<string, unknown>): AgentLifecycleEvent {
    return this.transition('ready', 'model_end', { model, metadata });
  }

  toolStart(tool: string, metadata?: Record<string, unknown>): AgentLifecycleEvent {
    return this.transition('tool_wait', 'tool_start', { tool, metadata });
  }

  /** The tool returned, successfully or not. */
  toolEnd(tool: string, metadata?: Record<string, unknown>): AgentLifecycleEvent {
    return this.transition('ready', 'tool_end', { tool, metadata });
  }

  complete(metadata?: Record<string, unknown>): AgentLifecycleEvent {
    return this.transition('completed', 'task_complete', { metadata });
  }

  fail(error?: unknown, metadata?: Record<string, unknown>): AgentLifecycleEvent {
    const message = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined;
    return this.transition('failed', 'error', {
      metadata: { ...(message ? { error: message } : {}), ...metadata },
    });
  }

  /**
   * Joule's core has no cancellation subsystem today; this exists so a caller
   * that acquires one records it as a lifecycle transition rather than a new
   * kind of state.
   */
  cancel(metadata?: Record<string, unknown>): AgentLifecycleEvent {
    return this.transition('cancelled', 'cancelled', { metadata });
  }

  metrics(now?: number): LifecycleMetrics {
    return computeLifecycleMetrics(this.log, { startTime: this.startTime, now: now ?? this.clock() });
  }

  timeline(now?: number): string {
    return renderLifecycleTimeline(this.taskId, this.log, { startTime: this.startTime, now: now ?? this.clock() });
  }
}

// ── Wrapping awaits ──────────────────────────────────────────────────

/**
 * Run `fn` inside a `tool_wait` segment, closing it even if `fn` throws, so a
 * failure can never leave the lifecycle stuck in an active state.
 */
export async function inToolWait<T>(
  tracker: AgentLifecycleTracker,
  tool: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>,
  /**
   * Maps the call's result onto extra metadata for the closing event. A record
   * that only says `file_write` cannot distinguish a write that landed from one
   * that was rejected, so callers that know the outcome report it here.
   */
  outcome?: (result: T) => Record<string, unknown>,
): Promise<T> {
  tracker.toolStart(tool, metadata);
  let closing = metadata;
  try {
    const result = await fn();
    if (outcome) closing = { ...metadata, ...outcome(result) };
    return result;
  } catch (err) {
    closing = { ...metadata, ok: false, error: err instanceof Error ? err.message : String(err) };
    throw err;
  } finally {
    tracker.toolEnd(tool, closing);
  }
}

/** Run `fn` inside a `model_running` segment. */
export async function inModelCall<T>(
  tracker: AgentLifecycleTracker,
  fn: () => Promise<T>,
  model?: string,
  metadata?: Record<string, unknown>,
): Promise<T> {
  tracker.modelStart(model, metadata);
  try {
    return await fn();
  } finally {
    tracker.modelEnd(model, metadata);
  }
}

// ── Metrics ──────────────────────────────────────────────────────────

export interface LifecycleMetricsOptions {
  /** When the agent entered `ready`; defaults to the first event's timestamp */
  startTime?: number;
  /** Clock used to close a run that has not reached a terminal state */
  now?: number;
}

/**
 * Timing rollup from the events alone: the agent starts in `ready`, each event
 * closes the segment before it, and a run without a terminal state is closed at
 * `now` (or at its last event, if no clock is given).
 */
export function computeLifecycleMetrics(
  events: readonly AgentLifecycleEvent[],
  opts: LifecycleMetricsOptions = {},
): LifecycleMetrics {
  const last = events[events.length - 1];
  const start = opts.startTime ?? events[0]?.timestamp ?? 0;
  const ended = last !== undefined && isTerminalLifecycleState(last.to);
  const end = ended ? last.timestamp : Math.max(start, opts.now ?? last?.timestamp ?? start);

  let modelRuntimeMs = 0;
  let toolWaitMs = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  const toolWaits: number[] = [];
  let state: AgentLifecycleState = 'ready';
  let since = start;

  const close = (until: number): void => {
    const dt = Math.max(0, until - since);
    if (state === 'model_running') modelRuntimeMs += dt;
    else if (state === 'tool_wait') {
      toolWaitMs += dt;
      toolWaits.push(dt);
    }
  };

  for (const e of events) {
    close(e.timestamp);
    if (e.to === 'model_running') modelCalls++;
    if (e.to === 'tool_wait') toolCalls++;
    state = e.to;
    since = e.timestamp;
  }
  // A run cut short mid-call still spent the time it spent.
  if (!isTerminalLifecycleState(state)) close(end);

  const totalRuntimeMs = Math.max(0, end - start);
  return {
    totalRuntimeMs,
    modelRuntimeMs,
    toolWaitMs,
    idleFraction: totalRuntimeMs > 0 ? toolWaitMs / totalRuntimeMs : 0,
    otherMs: Math.max(0, totalRuntimeMs - modelRuntimeMs - toolWaitMs),
    modelCalls,
    toolCalls,
    avgToolWaitMs: toolWaits.length > 0 ? toolWaits.reduce((a, b) => a + b, 0) / toolWaits.length : 0,
    p95ToolWaitMs: percentile(toolWaits, 0.95),
    finalState: last?.to ?? state,
  };
}

/** Nearest-rank percentile; 0 for an empty sample. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

// ── Development formatter ────────────────────────────────────────────

/**
 * Human-readable timeline of one run, for debugging and for `joule trace`:
 *
 *     0.000s  READY
 *     0.021s  MODEL_RUNNING   qwen2.5
 *     1.328s  READY
 */
export function renderLifecycleTimeline(
  taskId: string,
  events: readonly AgentLifecycleEvent[],
  opts: LifecycleMetricsOptions = {},
): string {
  const metrics = computeLifecycleMetrics(events, opts);
  const start = opts.startTime ?? events[0]?.timestamp ?? 0;
  const at = (t: number): string => `${((t - start) / 1000).toFixed(3)}s`.padStart(8);

  const lines: string[] = [`Task: ${taskId}`, ''];
  lines.push(`${at(start)}  READY`);
  events.forEach((e, i) => {
    // Label the state being entered. The model is known only once the call
    // returns, so MODEL_RUNNING borrows it from the event that closes it.
    const label = e.to === 'model_running'
      ? e.model ?? events[i + 1]?.model ?? ''
      : e.to === 'tool_wait'
        ? e.tool ?? ''
        : '';
    lines.push(`${at(e.timestamp)}  ${e.to.toUpperCase().padEnd(15)} ${label}`.trimEnd());
  });

  const pct = (ms: number): string =>
    `${metrics.totalRuntimeMs > 0 ? ((ms / metrics.totalRuntimeMs) * 100).toFixed(1) : '0.0'}%`.padStart(6);
  const secs = (ms: number): string => `${(ms / 1000).toFixed(3)}s`.padStart(8);
  lines.push('', '-'.repeat(32));
  lines.push(`Total:     ${secs(metrics.totalRuntimeMs)}`);
  lines.push(`Model:     ${secs(metrics.modelRuntimeMs)} ${pct(metrics.modelRuntimeMs)}   ${metrics.modelCalls} call(s)`);
  lines.push(`Tool wait: ${secs(metrics.toolWaitMs)} ${pct(metrics.toolWaitMs)}   ${metrics.toolCalls} call(s)`);
  lines.push(`Other:     ${secs(metrics.otherMs)} ${pct(metrics.otherMs)}`);
  lines.push('-'.repeat(32));
  return lines.join('\n');
}

/**
 * One line per agent in a crew run: did it execute, did it fail, why, how far
 * it got, and what it was allowed to spend.
 *
 * This exists because counts alone could not explain a crew: agents that made
 * zero model calls looked identical to agents that had nothing to do. The
 * fields here are the ones that separate those cases.
 */
export function renderCrewDiagnostic(
  agents: readonly {
    agentId: string;
    role?: string;
    taskResult: {
      status: string;
      error?: string;
      lifecycle?: readonly AgentLifecycleEvent[];
      lifecycleMetrics?: LifecycleMetrics;
    };
    budgetUsed?: { tokensUsed?: number; tokensRemaining?: number };
  }[],
): string {
  const lines: string[] = [];

  agents.forEach((agent, i) => {
    const result = agent.taskResult;
    const metrics = result.lifecycleMetrics;
    const events = result.lifecycle ?? [];
    const last = events[events.length - 1];
    // `ready` here means the run ended without ever reaching a model or a tool.
    const failedFrom = last !== undefined && (last.to === 'failed' || last.to === 'cancelled')
      ? last.from
      : undefined;
    const used = agent.budgetUsed?.tokensUsed;
    const ceiling = used !== undefined && agent.budgetUsed?.tokensRemaining !== undefined
      ? used + agent.budgetUsed.tokensRemaining
      : undefined;

    lines.push(`Agent ${i + 1} / ${agent.role ?? agent.agentId}`);
    lines.push(`  status:      ${result.status}`);
    if (result.error) lines.push(`  error:       ${result.error.split('\n')[0]}`);
    if (failedFrom) lines.push(`  failedFrom:  ${failedFrom}`);
    lines.push(`  modelCalls:  ${metrics?.modelCalls ?? 0}`);
    lines.push(`  toolCalls:   ${metrics?.toolCalls ?? 0}`);
    lines.push(`  tokens:      ${used ?? 0}${ceiling !== undefined ? ` / ${ceiling}` : ''}`);
  });

  return lines.join('\n');
}
