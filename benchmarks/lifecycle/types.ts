/**
 * Lifecycle characterization — measurement types.
 *
 * One record per agent run, plus per-workflow concurrency summaries. Everything
 * here is derived from the lifecycle events Joule already emits
 * (`TaskResult.lifecycle`); nothing is measured a second way.
 *
 * Timestamps in lifecycle events come from a monotonic clock, which is only
 * comparable inside one process. `runId` marks a single process, so records are
 * only ever compared with others that share it.
 */

import type { AgentLifecycleEvent, AgentLifecycleState } from '@joule/shared';

/** How the agent was executed: the 7-phase pipeline, or the direct loop. */
export type AgentExecutionMode = 'full' | 'direct';

/**
 * One tool call, as the lifecycle recorded it.
 *
 * Counting tool calls cannot tell a specialist that read the code from one
 * that rewrote it, and cannot tell a write that landed from one that was
 * rejected. The name and the outcome can.
 */
export interface ToolCallRecord {
  tool: string;
  durationMs: number;
  /** Whether the call succeeded, when the caller reported it */
  ok?: boolean;
  /** Set when a verified-edit gate reverted this write */
  rolledBack?: boolean;
  /** Failure message, first line only */
  error?: string;
}

/** One agent run. The unit of the experiment. */
export interface AgentLifecycleRecord {
  /** The process/run this came from; timestamps are only comparable within it */
  runId: string;
  taskId: string;
  /** Workload identity the run came from (benchmark problem / SWE-bench instance) */
  workloadId?: string;
  parentTaskId?: string;
  agentId: string;
  agentRole?: string;
  executionMode: AgentExecutionMode;
  status: string;
  success: boolean;
  /**
   * Why the run ended this way, when it did not complete. An agent that makes
   * no model calls is indistinguishable from one that was never asked to
   * unless the reason is kept.
   */
  error?: string;
  /**
   * The state the run was in when it failed. `ready` means it failed before
   * reaching a model or a tool at all.
   */
  failedFrom?: AgentLifecycleState;

  totalRuntimeMs: number;
  modelRuntimeMs: number;
  toolWaitMs: number;
  otherMs: number;
  idleFraction: number;

  modelCalls: number;
  toolCalls: number;

  avgToolWaitMs: number;
  p95ToolWaitMs: number;
  maxToolWaitMs: number;
  minToolWaitMs: number;
  /** Every contiguous tool_wait window, in the order they happened */
  toolWaitDurationsMs: number[];
  /** The same windows with the tool that was called and how it went, in order */
  tools: ToolCallRecord[];

  lifecycleEvents: AgentLifecycleEvent[];
}

/** A contiguous interval an agent spent in one state. */
export interface LifecycleInterval {
  start: number;
  end: number;
}

// ── Aggregates ───────────────────────────────────────────────────────

export interface RuntimeStats {
  mean: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface IdleStats {
  mean: number;
  median: number;
  p25: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface ToolWaitStats {
  /** Number of individual tool-wait windows, not number of runs */
  count: number;
  mean: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
}

/** How many tool-wait windows fall in each latency band. */
export interface DurationBucket {
  label: string;
  lowerMs: number;
  /** Exclusive upper bound; `null` for the open-ended top bucket */
  upperMs: number | null;
  count: number;
  /** Share of all tool-wait windows, 0..1 */
  percentage: number;
}

/** Share of tool-wait windows longer than a threshold. */
export interface ThresholdShare {
  thresholdMs: number;
  count: number;
  /** Share of all tool-wait windows, 0..1 */
  fraction: number;
}

/**
 * How much tool-wait time would remain usable if something with a fixed
 * start-up cost were run inside those windows. Arithmetic over measured
 * durations only: nothing here migrates, moves or schedules anything, and no
 * cost value is endorsed as achievable.
 */
export interface HideableWindow {
  /** Hypothetical fixed overhead, in ms */
  migrationCostMs: number;
  /** Waits strictly longer than the overhead */
  eligibleWaits: number;
  eligibleFraction: number;
  /** Sum of max(0, wait - overhead) */
  hideableMs: number;
  /** hideableMs / total tool-wait time */
  hideableFraction: number;
}

/**
 * Tool wait that coincides with another agent needing the model.
 *
 * The question this answers is not "does an agent wait?" but "while it waits,
 * is anyone else asking for inference?" — the difference between idle time and
 * time another agent could actually use.
 */
export interface ReclaimableStats {
  totalToolWaitMs: number;
  /** Tool wait overlapping at least one other agent in model_running */
  reclaimableToolWaitMs: number;
  reclaimableFraction: number;
  /** Tool wait with nobody else asking for the model */
  isolatedToolWaitMs: number;
  /**
   * The same overlap, counting only what survives a fixed start-up cost paid
   * when the wait begins: overlap of [waitStart + cost, waitEnd] with other
   * agents' model demand.
   */
  afterCost: Array<{ migrationCostMs: number; reclaimableMs: number; fractionOfToolWait: number }>;
}

/** Per execution mode, so full and direct agents can be compared. */
export interface ModeBreakdown {
  executionMode: AgentExecutionMode;
  runs: number;
  successRate: number;
  medianIdleFraction: number;
  medianTotalRuntimeMs: number;
  toolWaitWindows: number;
}

export interface LifecycleAggregate {
  runs: number;
  agents: number;
  workflows: number;
  successRate: number;

  totalRuntimeMs: RuntimeStats;
  idleFraction: IdleStats;
  toolWaitMs: ToolWaitStats;
  buckets: DurationBucket[];
  /** Waits above 500ms / 1s / 2s / 5s / 10s */
  overThresholds: ThresholdShare[];
  /** Analysis-only: usable time left under hypothetical fixed overheads */
  hideable: HideableWindow[];
  /** Cross-agent: tool wait that coincides with another agent's model demand */
  reclaimable: ReclaimableStats;

  /** Totals across every record, for a quick where-does-the-time-go view */
  totals: {
    runtimeMs: number;
    modelRuntimeMs: number;
    toolWaitMs: number;
    otherMs: number;
    modelCalls: number;
    toolCalls: number;
  };

  byMode: ModeBreakdown[];
}

/**
 * One crew run (or one standalone task treated as its own workflow).
 * Concurrency is computed from lifecycle timestamps by sweeping interval
 * boundaries — never by polling.
 */
export interface WorkflowLifecycleSummary {
  runId: string;
  parentTaskId: string;
  agentCount: number;

  /** First agent start to last agent finish */
  wallClockRuntimeMs: number;
  /** Sum of every agent's own runtime; exceeds wall clock when agents overlap */
  totalAgentRuntimeMs: number;

  maxConcurrentAgents: number;
  avgConcurrentAgents: number;
  maxConcurrentModelRunning: number;
  avgConcurrentModelRunning: number;
  maxConcurrentToolWait: number;
  avgConcurrentToolWait: number;

  /** Wall-clock time with 2+ agents in model_running at once */
  modelDemandOverlapMs: number;
  /** modelDemandOverlapMs / wallClockRuntimeMs */
  modelDemandOverlapFraction: number;

  /** Tool wait in this workflow that coincides with another agent's model demand */
  reclaimableToolWaitMs: number;
  reclaimableFraction: number;
}

/** What the analyzer writes to summary.json. */
export interface LifecycleAnalysis {
  generatedAt: string;
  source: string;
  aggregate: LifecycleAggregate;
  workflows: WorkflowLifecycleSummary[];
}
