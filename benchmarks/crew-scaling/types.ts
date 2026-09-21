/**
 * Crew-scaling experiment — how much does an extra agent actually buy?
 *
 * One record per (task, crew width) run. Measurement only: nothing here sizes
 * a crew, and no policy in Joule reads these records.
 */

import type { ToolCallRecord } from '../lifecycle/types.js';

export type { ToolCallRecord };

export type CrewWidth = 1 | 2 | 3 | 4;

export interface AgentContribution {
  agentId: string;
  role?: string;
  success?: boolean;
  /**
   * The run's own terminal status, and why it ended that way.
   *
   * Counts alone cannot separate an agent that had nothing to do from one that
   * was never able to start: fifteen agents across datasets E and E2 made zero
   * model calls and the artifacts could not say why.
   */
  status?: string;
  error?: string;
  /** Lifecycle state the run failed from; `ready` means it never started work */
  failedFrom?: string;
  costUsd?: number;
  tokens?: number;
  modelCalls: number;
  toolCalls: number;
  /** Every tool call in order, with its outcome */
  tools?: ToolCallRecord[];
  /**
   * Writes this agent proposed versus writes that survived verification.
   * Activity is not contribution: an agent can work hard and make it worse.
   */
  proposedWrites?: number;
  acceptedWrites?: number;
  rolledBackWrites?: number;
}

export interface CrewScalingRecord {
  runId: string;
  taskId: string;
  /** Benchmark problem the task came from */
  workloadId: string;
  crewWidth: CrewWidth;
  roles: string[];
  /**
   * Repetition index. There is no model seed to set here: runs differ only
   * through the provider's own sampling at a fixed temperature.
   */
  seed: number;

  /** Deterministic evaluator result: the problem's own tests passed */
  success: boolean;
  failureReason?: string;
  /** Status the crew itself reported: completed, partial or failed */
  crewStatus?: string;
  /** The crew's own error, when orchestration failed rather than the task */
  crewError?: string;
  /**
   * Set when the run threw before producing a crew result. Such runs used to
   * be printed to stderr and dropped, so the artifact silently held fewer
   * rows than the experiment attempted.
   *
   * Their measurements are zeroed, not measured: the outcome is a real
   * failure, but cost, tokens and runtime on these rows mean "unknown", so an
   * analysis that averages them will understate the width they belong to.
   */
  runError?: string;

  /**
   * Resource measurements are absent, not zero, when a run never produced
   * them. A run that died before execution has no cost, runtime or token
   * count to report, and writing zeros there would pull every average it is
   * included in towards zero. Outcome fields above stay present for every
   * attempt, so a failure still counts against the success rate.
   */
  workflowJctMs?: number;

  totalCostUsd?: number;
  totalTokens?: number;
  /**
   * Prompt/completion split is not tracked per agent on the direct execution
   * path, so these stay undefined rather than being guessed at.
   */
  inputTokens?: number;
  outputTokens?: number;

  modelCalls?: number;
  toolCalls?: number;
  modelRuntimeMs?: number;
  toolWaitMs?: number;

  /** Agents that made at least one model or tool call */
  activeAgents?: number;
  /** Whether the verified-edit gate was enabled; absent in datasets E and E2 */
  gateEnabled?: boolean;
  /** Totals across the crew's agents, when the gate ran */
  proposedWrites?: number;
  acceptedWrites?: number;
  rolledBackWrites?: number;
  agentResults: AgentContribution[];
}

// ── Analysis ─────────────────────────────────────────────────────────

/**
 * How many runs a number was computed over.
 *
 * Outcome and resource statistics have different denominators: every attempt
 * counts towards the success rate, but only runs that measured something can
 * contribute to an average. Without these counts the denominator changes
 * silently whenever a run dies early.
 */
export interface AggregateDenominators {
  /** Every run the experiment attempted at this width */
  attemptedRuns: number;
  /** Attempts that produced usable resource measurements */
  measuredRuns: number;
  /** Runs behind each resource average */
  jctRuns: number;
  costRuns: number;
  tokenRuns: number;
}

export interface WidthAggregate extends AggregateDenominators {
  crewWidth: CrewWidth;
  /** Alias of `attemptedRuns`, kept because the reports read it */
  runs: number;
  successes: number;
  /** successes / attemptedRuns — a run that died early is still a failure */
  successRate: number;
  /** Averages over the runs that measured them; 0 when there are none */
  meanJctMs: number;
  medianJctMs: number;
  meanCostUsd: number;
  medianCostUsd: number;
  meanTokens: number;
  meanModelCalls: number;
  meanToolCalls: number;
  meanActiveAgents: number;
  /** activeAgents / crewWidth, averaged */
  activeAgentFraction: number;
}

/** One width step, measured on the tasks that ran at both widths. */
export interface MarginalStep {
  from: CrewWidth;
  to: CrewWidth;
  /** Tasks that ran at both widths — the denominator for the outcome counts */
  pairedTasks: number;
  /** Of those, pairs where both runs measured resources — the denominator for the deltas */
  measuredPairs: number;
  /** Tasks the wider crew solved that the narrower one did not */
  newlySolved: number;
  /** Tasks the narrower crew solved that the wider one lost */
  regressions: number;
  netSolved: number;
  deltaCostUsd: number;
  deltaCostPct: number;
  deltaJctMs: number;
  deltaJctPct: number;
  deltaTokens: number;
  deltaModelCalls: number;
  deltaToolCalls: number;
  /** Additional tasks solved per additional dollar, when any cost was added */
  solvedPerDollar?: number;
  /** Additional tasks solved per additional million tokens */
  solvedPerMillionTokens?: number;
}

/**
 * A wider run is dominated when it buys nothing: no better outcome, more
 * money, and no better latency.
 */
export interface DominanceStep {
  from: CrewWidth;
  to: CrewWidth;
  pairedTasks: number;
  /** Pairs where both runs measured cost and latency; dominance needs both */
  comparablePairs: number;
  dominated: number;
  /** dominated / comparablePairs */
  dominatedFraction: number;
  /** Same outcome, but the narrower crew was cheaper */
  sameOutcomeCheaper: number;
}

export interface MinimumWidthSummary {
  /** workloadId -> smallest width that solved it, or null if never solved */
  byTask: Array<{ workloadId: string; minimumSuccessfulWidth: CrewWidth | null }>;
  solvedAtWidth: Record<string, number>;
  neverSolved: number;
}

/** Oracle: pick each task's minimum successful width, compare with always-4. */
export interface OracleSavings {
  tasksConsidered: number;
  alwaysWidestCostUsd: number;
  oracleCostUsd: number;
  costSavedUsd: number;
  costSavedPct: number;
  alwaysWidestTokens: number;
  oracleTokens: number;
  tokensSavedPct: number;
  alwaysWidestJctMs: number;
  oracleJctMs: number;
  jctChangePct: number;
  /** Tasks solved under each strategy (the oracle never loses an outcome) */
  alwaysWidestSolved: number;
  oracleSolved: number;
}

export interface CrewScalingAnalysis {
  generatedAt: string;
  source: string;
  runs: number;
  /** Runs attempted (= `runs`) and how many of them measured resources */
  attemptedRuns: number;
  measuredRuns: number;
  tasks: number;
  widths: WidthAggregate[];
  marginal: MarginalStep[];
  dominance: DominanceStep[];
  minimumWidth: MinimumWidthSummary;
  oracle: OracleSavings;
}
