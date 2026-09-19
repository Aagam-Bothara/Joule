/**
 * Agent lifecycle instrumentation.
 *
 * The logical execution state of one agent run: thinking (a model call is in
 * flight), waiting on a tool, or finished. This is observation only — nothing
 * in the execution path branches on it — and it answers one question: how much
 * of a run's wall clock goes to model inference versus waiting for tools.
 *
 * These states describe the AGENT, not the machine it runs on. Placement,
 * memory and cache states belong to a resource-management layer, not here.
 */

// ── States ───────────────────────────────────────────────────────────

export type AgentLifecycleState =
  | 'ready'
  | 'model_running'
  | 'tool_wait'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Why a transition happened. */
export type AgentLifecycleReason =
  | 'model_start'
  | 'model_end'
  | 'tool_start'
  | 'tool_end'
  | 'task_complete'
  | 'error'
  | 'cancelled';

export const TERMINAL_LIFECYCLE_STATES: readonly AgentLifecycleState[] = ['completed', 'failed', 'cancelled'];

/**
 * Where each state may go next. A run alternates between `ready` and one of the
 * two active states, and may end from any of the three; terminal states have
 * no successors, so `completed -> model_running` is rejected rather than
 * silently applied.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<AgentLifecycleState, readonly AgentLifecycleState[]>> = {
  ready: ['model_running', 'tool_wait', 'completed', 'failed', 'cancelled'],
  model_running: ['ready', 'failed', 'cancelled'],
  tool_wait: ['ready', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalLifecycleState(state: AgentLifecycleState): boolean {
  return TERMINAL_LIFECYCLE_STATES.includes(state);
}

export function canTransitionLifecycle(from: AgentLifecycleState, to: AgentLifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

// ── Events ───────────────────────────────────────────────────────────

/**
 * One state change. `taskId` and `agentId` identify the run; everything else
 * the trace already records (tokens, cost, tool arguments) stays in the
 * `model_call` and `tool_call` events and is not duplicated here.
 */
export interface AgentLifecycleEvent {
  taskId: string;
  /**
   * The agent, not the task: one task can have several agents running their
   * own lifecycles at once, so this never repeats `taskId`.
   */
  agentId: string;
  /** Task this one was spawned from, for agents working under a parent task */
  parentTaskId?: string;
  /** Crew role of the agent, when it has one */
  agentRole?: string;
  from: AgentLifecycleState;
  to: AgentLifecycleState;
  /** Monotonic milliseconds (`monotonicNow`), the same clock trace events use */
  timestamp: number;
  reason?: AgentLifecycleReason;
  /** Model that ran, on `model_start` / `model_end` when known */
  model?: string;
  /** Tool that ran, on `tool_start` / `tool_end` */
  tool?: string;
  metadata?: Record<string, unknown>;
}

// ── Metrics ──────────────────────────────────────────────────────────

/** Timing rollup over a run's lifecycle events. */
export interface LifecycleMetrics {
  /** Wall clock from the first `ready` to the terminal state (or to now, if still running) */
  totalRuntimeMs: number;
  /** Time in `model_running` */
  modelRuntimeMs: number;
  /** Time in `tool_wait` */
  toolWaitMs: number;
  /** `toolWaitMs / totalRuntimeMs`; 0 when the run had no measurable duration */
  idleFraction: number;
  /** Time in neither: policy evaluation, verification bookkeeping, parsing */
  otherMs: number;
  modelCalls: number;
  toolCalls: number;
  avgToolWaitMs: number;
  /** Nearest-rank 95th percentile of individual tool waits */
  p95ToolWaitMs: number;
  /** State the run ended in, or the state it is currently in */
  finalState: AgentLifecycleState;
}
