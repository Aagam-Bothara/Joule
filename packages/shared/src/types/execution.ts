/**
 * Adaptive execution types.
 *
 * Joule's core execution model:
 *
 *   Task → StepAgent (SLM by default) → Execute / Observe → EscalationPolicy
 *            ├── continue  → same tier keeps working
 *            ├── consult   → one focused question to the LLM, then back to the SLM
 *            ├── handoff   → LLM takes over from the current state (no restart)
 *            └── abort     → budget / safety / impossible task
 *
 * Everything the run has learned lives in `ExecutionState`. The LLM never
 * restarts from the original prompt — consultations and handoffs are built
 * from this state.
 */

import type { BudgetUsage } from './budget.js';
import type { ModelTier } from './model.js';
import type { StepResult } from './task.js';

// ── Modes ────────────────────────────────────────────────────────────

/**
 * - `adaptive`      SLM-first step agent with the escalation policy (Joule's core)
 * - `slm-only`      step agent pinned to the SLM tier; never consults or hands off
 * - `mid-only`      step agent pinned to the MID tier (efficient large model)
 * - `llm-only`      step agent pinned to the LLM tier
 * - `static-router` legacy plan-then-execute pipeline with per-call routing
 */
export type ExecutionMode = 'adaptive' | 'slm-only' | 'mid-only' | 'llm-only' | 'static-router';

export const EXECUTION_MODES: readonly ExecutionMode[] = [
  'adaptive',
  'slm-only',
  'mid-only',
  'llm-only',
  'static-router',
];

export type EscalationAction = 'continue' | 'consult' | 'handoff' | 'abort';

// ── Signals ──────────────────────────────────────────────────────────

/**
 * Confidence built from observable evidence only. No model self-report
 * enters the composite.
 */
export interface Confidence {
  /** Weighted composite in [0, 1] */
  composite: number;
  /** Did the most recent action work? (1 success, 0 failure, 0.5 no action yet) */
  toolSuccess: number;
  /** Deterministic verifier result (1 pass, 0 fail, 0.5 none ran) */
  verification: number;
  /** Fraction of recent steps that produced new, successful, verified work */
  progress: number;
  /** Penalty in [0, 1]: same failure signature seen more than once */
  repeatedFailure: number;
  /** Penalty in [0, 1]: tool reported success but verification failed */
  contradiction: number;
  /** Fraction of the cost/token budget still available */
  budgetHeadroom: number;
}

export interface EscalationDecision {
  step: number;
  action: EscalationAction;
  /** Composite confidence at decision time */
  score: number;
  reason: string;
  confidence: Confidence;
  /** Tier that was driving when the decision was made */
  tier: ModelTier;
  /** Estimated cost of the escalation action, when one was chosen */
  estimatedCostUsd?: number;
  consultId?: string;
  timestamp: string;
}

// ── State ────────────────────────────────────────────────────────────

export interface Observation {
  step: number;
  source: 'tool' | 'verifier' | 'agent' | 'consult';
  /** Compact text — tool outputs are truncated before storage */
  content: string;
  toolName?: string;
  success?: boolean;
}

export type FailureKind =
  | 'tool_error'
  | 'verification_failed'
  | 'missing_tool'
  | 'malformed_action'
  | 'model_error';

export interface Failure {
  step: number;
  toolName: string;
  /** Normalized error signature (paths, ids, numbers stripped) */
  signature: string;
  message: string;
  /** Occurrences of this signature so far in the run */
  count: number;
  kind: FailureKind;
}

export interface Hypothesis {
  step: number;
  text: string;
  source: 'agent' | 'consult';
}

export interface Advice {
  consultId: string;
  step: number;
  question: string;
  answer: string;
  model: string;
  tokens: number;
  costUsd: number;
}

export interface PlanVersion {
  version: number;
  /** Step index at which this version was created */
  step: number;
  steps: string[];
  source: 'agent' | 'consult' | 'handoff';
}

export type ExecutionStatus = 'running' | 'completed' | 'blocked' | 'failed' | 'aborted';

export interface ExecutionState {
  taskId: string;
  goal: string;
  constraints: string[];
  mode: ExecutionMode;
  /** Tier currently driving execution */
  tier: ModelTier;

  /** Append-only. The latest version is the current plan. */
  planVersions: PlanVersion[];
  /** Index of the next step to execute */
  step: number;

  completedSteps: StepResult[];
  observations: Observation[];
  failures: Failure[];
  hypotheses: Hypothesis[];
  advice: Advice[];
  decisions: EscalationDecision[];

  consultations: number;
  handoffs: number;
  handoffAtStep?: number;

  budget: BudgetUsage;
  status: ExecutionStatus;
  result?: string;
  error?: string;
  startedAt: string;
}

// ── Consult / Handoff payloads ───────────────────────────────────────

export interface ConsultationRequest {
  consultId: string;
  goal: string;
  question: string;
  relevantEvidence: Observation[];
  hypotheses: Hypothesis[];
  attemptedSolutions: StepResult[];
  constraints: string[];
  maxTokens: number;
}

export interface HandoffContext {
  originalGoal: string;
  currentPlan: string[];
  completedWork: StepResult[];
  relevantObservations: Observation[];
  hypotheses: Hypothesis[];
  failures: Failure[];
  advice: Advice[];
  unresolvedQuestions: string[];
  recommendedNextSteps: string[];
  remainingBudget: BudgetUsage;
}

// ── Policy configuration ─────────────────────────────────────────────

export interface EscalationPolicyConfig {
  /** Hard cap on agent steps per task. Default: 25 */
  maxSteps?: number;
  /** Composite confidence below which CONSULT is considered. Default: 0.55 */
  consultThreshold?: number;
  /** Composite confidence below which HANDOFF is considered. Default: 0.35 */
  handoffThreshold?: number;
  /** Total failures that trigger HANDOFF regardless of confidence. Default: 3 */
  maxFailuresBeforeHandoff?: number;
  /** Consultations allowed per task before the next escalation is a HANDOFF. Default: 3 */
  maxConsultations?: number;
  /** Token cap on a consultation answer. Default: 800 */
  consultMaxTokens?: number;
  /** Allow `llm_judge` step verification (non-deterministic). Default: false */
  llmJudge?: boolean;
  /** Steps without progress before CONSULT. Default: 3 */
  stallSteps?: number;
  /**
   * Verification failures the agent may retry on its own before a CONSULT is
   * considered, as long as it is not repeating the identical failure. Default: 1
   */
  verifyRetries?: number;
  /**
   * Escalation ladder, lowest rung first. Default: ['slm', 'mid', 'llm'] with
   * rungs no provider serves dropped, so a two-model setup is ['slm', 'llm'].
   * CONSULT asks the next rung; HANDOFF moves to the next rung; reasoning
   * breakdowns (repeated malformed output, give-up with no progress) skip to the top.
   */
  ladder?: ModelTier[];
  /**
   * Failures are counted within the last N steps of the current rung. "Stuck"
   * means failures concentrated recently, not a total accumulated over a long
   * task that is otherwise progressing. Default: 6
   */
  failureWindow?: number;
}

// ── Reporting ────────────────────────────────────────────────────────

export interface TierUsage {
  slmTokens: number;
  midTokens: number;
  llmTokens: number;
  slmCostUsd: number;
  midCostUsd: number;
  llmCostUsd: number;
  slmCalls: number;
  midCalls: number;
  llmCalls: number;
}

export interface TrajectoryStep {
  step: number;
  description: string;
  toolName?: string;
  tier: ModelTier;
  /** Model that proposed the step, when known */
  model?: string;
  success: boolean;
  verified?: boolean;
  action: EscalationAction;
  confidence: number;
  reason: string;
  consultId?: string;
}

export interface TrajectoryConsult {
  consultId: string;
  step: number;
  model: string;
  tokens: number;
  costUsd: number;
  question: string;
}

/** Per-task report emitted by every mode — the unit of benchmarking. */
export interface TrajectoryReport {
  taskId: string;
  mode: ExecutionMode;
  success: boolean;
  status: string;
  costUsd: number;
  /** Cost if every token had been billed at the LLM tier */
  estimatedLlmOnlyCostUsd?: number;
  latencyMs: number;
  slmTokens: number;
  /** Tokens spent at the optional middle rung */
  midTokens?: number;
  llmTokens: number;
  consultations: number;
  handoffs: number;
  handoffAtStep?: number;
  toolCalls: number;
  trajectoryLength: number;
  verifierKinds: string[];
  steps: TrajectoryStep[];
  consults: TrajectoryConsult[];
  decisions: EscalationDecision[];
}
