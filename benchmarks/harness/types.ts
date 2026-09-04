import type { ExecutionMode, TaskResult, ToolDefinition, TrajectoryReport } from '@joule/shared';
import type { ModelRequest } from '@joule/shared';

/** A script entry is a fixed reply or a function of the request (lets mocks react to advice / handoff). */
export type ScriptEntry = string | ((req: ModelRequest, callIndex: number) => string);

export interface MockScripts {
  slm: ScriptEntry[];
  llm: ScriptEntry[];
}

export interface Workload {
  id: string;
  description: string;
  complexity: 'low' | 'medium' | 'high';
  /** Tools registered for this task (mock workloads) */
  tools?: () => ToolDefinition[];
  /** Scripted model behaviour (mock workloads) */
  scripts?: MockScripts;
  /** Runs before every attempt (resets sandbox state) */
  setup?: () => void;
  /**
   * Deterministic success check on the final result. When absent, success is
   * `status === 'completed'` and the report is marked as status-judged.
   */
  verify?: (result: TaskResult) => boolean;
  /** What a judge / self-verifier should look at (defaults to the result text) */
  answerForJudge?: (result: TaskResult) => string;
  /** Escalation policy overrides for this workload (e.g. a higher step cap for long-horizon tasks) */
  policy?: { maxSteps?: number; maxConsultations?: number; maxFailuresBeforeHandoff?: number; failureWindow?: number };
  /** Budget envelope for this workload (default: the 'high' preset) */
  budget?: import('@joule/shared').Task['budget'];
}

export type StrategyName =
  | 'slm-only'
  | 'mid-only'
  | 'llm-only'
  | 'static-router'
  | 'naive-cascade'
  | 'frugal-cascade'
  | 'automix'
  | 'pre-router'
  | 'joule-adaptive'
  | 'joule-ladder';

/**
 * How a multi-stage strategy decides to move to the next mode:
 * - failure      the run did not complete (system-observable; EcoAssistant-style)
 * - judge        a cheap scorer rates the answer; escalate below a threshold (FrugalGPT-style)
 * - self-verify  the same model verifies its own answer k times; escalate on majority "no" (AutoMix-style)
 */
export type EscalationTrigger = 'failure' | 'judge' | 'self-verify';

export interface Strategy {
  name: StrategyName;
  /** Mode(s) this strategy runs, in order. */
  modes: ExecutionMode[];
  /** Trigger for moving to the next mode (multi-mode strategies only) */
  escalateOn?: EscalationTrigger;
  /** One cheap classification call decides the mode before running (RouteLLM-style) */
  preRoute?: boolean;
  /** Escalation ladder for adaptive runs; omitted = engine default (all available rungs) */
  ladder?: Array<'slm' | 'mid' | 'llm'>;
  description: string;
}

/** Cheap out-of-band model calls the baselines need (scorers, verifiers, routers). */
export interface GateContext {
  callModel: (
    tier: 'slm' | 'llm',
    system: string,
    user: string,
    opts?: { temperature?: number; maxTokens?: number },
  ) => Promise<{ content: string; costUsd: number; tokens: number }>;
}

/** The per-task record every strategy produces. */
export interface TaskReport {
  workloadId: string;
  strategy: StrategyName;
  success: boolean;
  status: string;
  verifierKind: 'deterministic' | 'status';
  cost: number;
  /** Cost of scorer / verifier / router calls, included in `cost` */
  gateCost: number;
  estimatedLlmOnlyCost?: number;
  latencyMs: number;
  slmTokens: number;
  /** Tokens at the optional middle rung */
  midTokens?: number;
  llmTokens: number;
  /** Did this strategy use any rung above the small model (middle or top)? */
  llmUsed: boolean;
  consultations: number;
  handoffs: number;
  toolCalls: number;
  trajectoryLength: number;
  /** Modes actually run, in order */
  modesRun: ExecutionMode[];
  /** Repeat index for counterfactual strategies run several times per task */
  repeat?: number;
  /** Full trajectory of the (last) run, when the mode produced one */
  trajectory?: TrajectoryReport;
  error?: string;
  /** Error events from the trace (model / tool failures) */
  errors?: string[];
  /** Verdicts of scorer / verifier / router calls, for auditing baselines */
  gateOutputs?: string[];
}

export interface StrategySummary {
  strategy: StrategyName;
  tasks: number;
  successRate: number;
  avgCost: number;
  totalCost: number;
  avgGateCost: number;
  avgLatencyMs: number;
  avgSlmTokens: number;
  avgLlmTokens: number;
  avgToolCalls: number;
  /** Fraction of tasks on which the LLM tier was used at all */
  llmUsedRate: number;
  consultations: number;
  handoffs: number;
}

export interface EscalationMetrics {
  strategy: StrategyName;
  escalated: number;
  /** Tasks where the SLM's estimated success probability is below 0.5 and the LLM succeeds */
  needed: number;
  truePositives: number;
  /** Hard precision: escalations on needed tasks / escalations */
  precision: number | null;
  /**
   * Soft precision: mean over escalated tasks of P(SLM fails) — credits an
   * escalation on a task the SLM only sometimes solves. Equals hard precision
   * when slm-only ran once.
   */
  softPrecision: number | null;
  /** Escalations on tasks the SLM solves at least 80% of the time (clearly wasted) */
  wasted: number;
  recall: number | null;
  consultSuccessRate: number | null;
  handoffSuccessRate: number | null;
  costRatioVsLlmOnly: number | null;
  successRate: number;
}

export interface HarnessReport {
  timestamp: string;
  runner: 'mock' | 'live';
  workload: string;
  models?: { slm: string; mid?: string; llm: string };
  strategies: StrategySummary[];
  escalation: EscalationMetrics[];
  baselines: { slmOnlySuccess: number | null; llmOnlySuccess: number | null; slmOnlyRepeats: number };
  tasks: TaskReport[];
}
