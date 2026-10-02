/**
 * Crew-scaling experiment — how much does an extra agent actually buy?
 *
 * One record per (task, crew width) run. Measurement only: nothing here sizes
 * a crew, and no policy in Joule reads these records.
 */

import type { StagedRecoveryReport } from '@joule/shared';
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
  /** Joule's token-based estimate (local price table) */
  costUsd?: number;
  /**
   * What the provider reported it billed for this agent's model calls, summed.
   * Absent when no call reported a cost; covers `billedModelCalls` of
   * `modelCalls` calls, so a partial sum is visible as one.
   */
  billedCostUsd?: number;
  billedModelCalls?: number;
  /** Model calls per upstream host that served them, when the provider named one */
  modelHosts?: Record<string, number>;
  tokens?: number;
  /**
   * Prompt / completion split of the agent's tokens, summed over its model
   * calls (direct execution path). `cachedPromptTokens` is the part of the
   * prompt the provider served from its cache; 0 or absent means none was
   * reported (the OpenAI-compatible provider omits it when it is 0).
   */
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  modelCalls: number;
  toolCalls: number;
  /** Every tool call in order, with its outcome */
  tools?: ToolCallRecord[];
  /**
   * What the agent reported when it finished, truncated.
   *
   * Without it, an agent that diagnosed the defect and then failed to act is
   * indistinguishable from one that inspected the code and found nothing —
   * the two cases a crew experiment most needs to separate.
   */
  answer?: string;
  /**
   * The verified-edit gate's view when this agent stopped: whether the check
   * was passing. For an agent that proposed no writes this is the state it
   * inherited, which is how "there was nothing to fix" becomes observable.
   */
  verified?: boolean;
  /**
   * Writes this agent proposed versus writes that survived verification.
   * Activity is not contribution: an agent can work hard and make it worse.
   */
  proposedWrites?: number;
  acceptedWrites?: number;
  rolledBackWrites?: number;
  /**
   * Regressions the gate tried to undo but could not (the restore failed).
   * Present only when non-zero; never included in `rolledBackWrites`.
   */
  restoreFailedWrites?: number;
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

  /** Joule's token-based cost estimate */
  totalCostUsd?: number;
  /**
   * Sum of what the provider reported it billed, across the crew's agents.
   * Absent when nothing was reported. It covers `billedModelCalls` of
   * `modelCalls`; a model call made outside the agents (a `custom` crew
   * aggregation) is not included.
   */
  totalBilledCostUsd?: number;
  billedModelCalls?: number;
  /** Model calls per upstream host, across the crew's agents */
  modelHosts?: Record<string, number>;
  totalTokens?: number;
  /**
   * Prompt/completion split, summed over the agents that reported it (direct
   * execution path records it since 2026-10-02; earlier records leave these
   * undefined rather than guessing). `cachedInputTokens` is the part of the
   * input served from the provider's prompt cache; 0 means none was reported.
   */
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;

  modelCalls?: number;
  toolCalls?: number;
  modelRuntimeMs?: number;
  toolWaitMs?: number;

  /** Agents that made at least one model or tool call */
  activeAgents?: number;
  /** Whether the verified-edit gate was enabled; absent in datasets E and E2 */
  gateEnabled?: boolean;
  /**
   * Stage-by-stage account, present when the crew ran with `staged_recovery`.
   * It is what says which stage settled the task and which never had to run.
   */
  staged?: StagedRecoveryReport;
  /** Totals across the crew's agents, when the gate ran */
  proposedWrites?: number;
  acceptedWrites?: number;
  rolledBackWrites?: number;
  /**
   * Real-repository runs: which check the gate and escalation used, and the
   * hidden SWE-bench score of the final state, measured apart from that check
   * (benchmarks/real-repo/workload.ts, `RealRepoRunRecord`).
   */
  checkMode?: 'oracle' | 'repro' | 'visible-f2p';
  checkFaithful?: boolean;
  hidden?: { resolved: boolean; f2pPassed: number; f2pTotal: number; p2pFailed: number; p2pTotal: number; error?: string };
  checkFinalPassed?: boolean;
  stage1Hidden?: { resolved: boolean; f2pPassed: number; f2pTotal: number; p2pFailed: number; p2pTotal: number; error?: string };
  /**
   * Real-repository runs outside oracle mode, reporting only (never shown to
   * an agent, read by no decision rule): the secondary regression score and
   * the diff audit of the final state (checks.ts `regressionScoreSource`,
   * audit.ts). `secondary.files` 0 means no test file matched, not "clean".
   */
  secondary?: { files: number; regressed: number; regressedTests?: string[]; timedOut?: string[]; error?: string };
  audit?: {
    changedFiles: string[];
    testInfraChanged: string[];
    testFilesRemoved?: string[];
    testFilesAdded: string[];
    suspicious: Array<{ file: string; reason: string; line: string }>;
    error?: string;
  };
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
