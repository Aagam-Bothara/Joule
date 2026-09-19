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

import type { AgentLifecycleEvent } from '@joule/shared';

/** How the agent was executed: the 7-phase pipeline, or the direct loop. */
export type AgentExecutionMode = 'full' | 'direct';

/** One agent run. The unit of the experiment. */
export interface AgentLifecycleRecord {
  /** The process/run this came from; timestamps are only comparable within it */
  runId: string;
  taskId: string;
  parentTaskId?: string;
  agentId: string;
  agentRole?: string;
  executionMode: AgentExecutionMode;
  status: string;
  success: boolean;

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
}

/** What the analyzer writes to summary.json. */
export interface LifecycleAnalysis {
  generatedAt: string;
  source: string;
  aggregate: LifecycleAggregate;
  workflows: WorkflowLifecycleSummary[];
}
