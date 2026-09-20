/**
 * Crew-scaling experiment — how much does an extra agent actually buy?
 *
 * One record per (task, crew width) run. Measurement only: nothing here sizes
 * a crew, and no policy in Joule reads these records.
 */

export type CrewWidth = 1 | 2 | 3 | 4;

export interface AgentContribution {
  agentId: string;
  role?: string;
  success?: boolean;
  costUsd?: number;
  tokens?: number;
  modelCalls: number;
  toolCalls: number;
}

export interface CrewScalingRecord {
  runId: string;
  taskId: string;
  /** Benchmark problem the task came from */
  workloadId: string;
  crewWidth: CrewWidth;
  roles: string[];

  /** Deterministic evaluator result: the problem's own tests passed */
  success: boolean;
  failureReason?: string;

  workflowJctMs: number;

  totalCostUsd: number;
  totalTokens: number;
  /**
   * Prompt/completion split is not tracked per agent on the direct execution
   * path, so these stay undefined rather than being guessed at.
   */
  inputTokens?: number;
  outputTokens?: number;

  modelCalls: number;
  toolCalls: number;
  modelRuntimeMs: number;
  toolWaitMs: number;

  /** Agents that made at least one model or tool call */
  activeAgents: number;
  agentResults: AgentContribution[];
}

// ── Analysis ─────────────────────────────────────────────────────────

export interface WidthAggregate {
  crewWidth: CrewWidth;
  runs: number;
  successes: number;
  successRate: number;
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
  pairedTasks: number;
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
  dominated: number;
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
  tasks: number;
  widths: WidthAggregate[];
  marginal: MarginalStep[];
  dominance: DominanceStep[];
  minimumWidth: MinimumWidthSummary;
  oracle: OracleSavings;
}
