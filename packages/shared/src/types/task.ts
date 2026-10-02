import type { BudgetPresetName, BudgetEnvelope, BudgetUsage } from './budget.js';
import type { ExecutionTrace } from './trace.js';
import type { EfficiencyReport } from './energy.js';
import type { SessionMessage } from './session.js';
import type { ModelTier } from './model.js';
import type { ExecutionMode, ExecutionState, TrajectoryReport } from './execution.js';
import type { AgentLifecycleEvent, LifecycleMetrics } from './lifecycle.js';

export interface Task {
  id: string;
  description: string;
  budget?: BudgetPresetName | Partial<BudgetEnvelope>;
  context?: Record<string, unknown>;
  tools?: string[];
  messages?: SessionMessage[];
  sessionId?: string;
  /** Execution strategy. Defaults to routing.defaultMode (static-router). */
  mode?: ExecutionMode;
  /**
   * Identity of the agent working this task, when several agents work toward
   * one goal (crews, sub-agents). Each gets its own lifecycle; `parentTaskId`
   * ties them back to the task they were spawned from.
   */
  agentId?: string;
  agentRole?: string;
  parentTaskId?: string;
  /**
   * Opt-in verified-edit gate. When set, an agent's write is checked with this
   * command and rolled back if it turns a passing state into a failing one.
   * Without it, writes behave exactly as before.
   */
  verifiedEdit?: VerifiedEditPolicy;
  createdAt: string;
}

/** How to check the workspace, and which tools to guard. */
export interface VerifiedEditPolicy {
  /** Shell command whose exit code decides whether the workspace is passing */
  command: string;
  /** Directory to run it in */
  cwd?: string;
  /**
   * What agents are told the check is, in place of `command`, e.g. "the
   * repository's check". Without it, messages show the command as before.
   * It changes only how the check is named; its output is reported unchanged.
   */
  label?: string;
  timeoutMs?: number;
  /** Tools treated as writes; defaults to file_write / file_edit / repo_write / repo_edit */
  tools?: string[];
  /**
   * Where the files a guarded write names actually live, so the gate can read
   * them before the write and put them back after a regression. Defaults to
   * the host filesystem. A harness whose tools edit files somewhere else (for
   * example inside a container) supplies its own. Runtime-only: it holds
   * functions, so it does not survive serialization of the task.
   */
  workspace?: EditWorkspace;
}

/**
 * The files the verified-edit gate snapshots and restores.
 *
 * Synchronous on purpose: the gate snapshots immediately before the tool runs
 * and restores immediately after the check, with nothing in between that may
 * interleave. Implementations throw when they cannot do what is asked; the
 * gate never treats a failed restore as a rollback.
 */
export interface EditWorkspace {
  /** Current content of `path`, or null when no such file exists */
  read(path: string): string | null;
  /** Replace the content of `path`, creating it if needed */
  write(path: string, content: string): void;
  /** Delete `path`; a missing file is not an error */
  remove(path: string): void;
}

export type TaskStatus =
  | 'pending'
  | 'specifying'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'recovering'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'budget_exhausted';

export interface StepResult {
  stepIndex: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  output: unknown;
  success: boolean;
  durationMs: number;
  error?: string;
  confidence?: number;
  /** Adaptive execution: what the step did (agent description) */
  description?: string;
  /** Adaptive execution: model and tier that proposed this step */
  model?: string;
  tier?: ModelTier;
  /** Set when the step ran under advice from a consultation */
  consultId?: string;
  /** Deterministic verification result, when a verifier ran */
  verified?: boolean;
  verifierKind?: string;
  /** Fraction of checks that passed (0..1), when the verifier could count them */
  verifyScore?: number;
  /** What the verifier saw (exit code, failing assertion, syntax error line) */
  verifyEvidence?: string;
  /** The agent's own confidence claim for this step, when asked (ablation) */
  selfConfidence?: number;
  /** Mean token log-probability of the action, when the provider returns logprobs */
  meanLogprob?: number;
}

export interface TaskResult {
  id: string;
  taskId: string;
  traceId: string;
  status: TaskStatus;
  result?: string;
  stepResults: StepResult[];
  budgetUsed: BudgetUsage;
  trace: ExecutionTrace;
  error?: string;
  completedAt: string;
  efficiencyReport?: EfficiencyReport;
  spec?: TaskSpec;
  criteriaResults?: CriterionResult[];
  simulationResult?: SimulationResult;
  decisionGraph?: DecisionGraph;
  /** Execution mode that produced this result */
  mode?: ExecutionMode;
  /** Adaptive execution: per-task trajectory report (escalation decisions, tier usage) */
  trajectory?: TrajectoryReport;
  /** Adaptive execution: final structured state */
  executionState?: ExecutionState;
  /**
   * Agent lifecycle transitions for this run, oldest first. Every execution
   * mode that is instrumented reports the same events here, so runs are
   * comparable regardless of which executor produced them.
   */
  lifecycle?: AgentLifecycleEvent[];
  /** Model / tool-wait timing rollup over `lifecycle` */
  lifecycleMetrics?: LifecycleMetrics;
  /**
   * Sum of what the provider reported it billed for this run's model calls
   * (OpenRouter's `usage.cost`), kept apart from the token-based estimate in
   * `budgetUsed.costUsd`. Absent when no call reported a billed cost.
   */
  billedCostUsd?: number;
  /** How many model calls reported a billed cost; compare with lifecycleMetrics.modelCalls */
  billedModelCalls?: number;
  /** Verified-edit gate activity, when a policy was set on the task */
  verifiedEdits?: {
    checks: number;
    rollbacks: number;
    /** Regressions the gate could not undo (a restore failed); never counted as rollbacks */
    restoreFailures?: number;
    /** Writes the gate reviewed */
    proposed: number;
    /** Writes that left the workspace verifying */
    accepted: number;
    acceptanceRate: number;
    verified?: boolean | undefined;
    byAuthor: Record<string, { proposed: number; accepted: number; rolledBack: number }>;
  };
}

// --- Task Specification (structured goal + success criteria) ---

export interface TaskSpec {
  goal: string;
  constraints: string[];
  successCriteria: SuccessCriterion[];
}

export interface SuccessCriterion {
  description: string;
  type: 'output_contains' | 'tool_succeeded' | 'page_state' | 'file_exists' | 'custom';
  check: Record<string, unknown>;
}

export interface CriterionResult {
  criterion: SuccessCriterion;
  met: boolean;
  evidence?: string;
}

// --- Step Verification (per-step assertion after execution) ---

export interface StepVerification {
  /**
   * - output_check  regex / substring over the tool output (deterministic)
   * - dom_check     browser_evaluate script must be truthy (deterministic)
   * - command_exit  run `command` via shell_exec; pass iff exit code matches (deterministic)
   * - test_result   like command_exit, and the output must also match `assertion` if set
   * - llm_judge     small-model judgement (non-deterministic; opt-in)
   */
  type: 'output_check' | 'dom_check' | 'command_exit' | 'test_result' | 'llm_judge' | 'none';
  assertion: string;
  /** command_exit / test_result: shell command to run */
  command?: string;
  cwd?: string;
  /** command_exit / test_result: expected exit code. Default: 0 */
  expectedExitCode?: number;
  retryOnFail?: boolean;
  maxRetries?: number;
}

// --- Agent State Machine ---

export type AgentState =
  | 'idle'
  | 'spec'
  | 'plan'
  | 'critique'
  | 'simulate'
  | 'decompose'
  | 'act'
  | 'observe'
  | 'verify'
  | 'recover'
  | 'checkpoint'
  | 'synthesize'
  | 'done'
  | 'failed'
  | 'stopped';

// --- Plan Critique (meta-reasoning) ---

export interface PlanScore {
  overall: number;
  stepConfidences: number[];
  issues: string[];
  refinedPlan?: { steps: any[] };
}

// --- Failure Learning ---

export interface FailurePattern {
  id: string;
  toolName: string;
  errorSignature: string;
  context: string;
  resolution?: string;
  occurrences: number;
  lastSeen: string;
}

// --- Execution Simulation ---

export interface SimulationResult {
  valid: boolean;
  issues: SimulationIssue[];
  estimatedBudget: { modelCalls: number; toolCalls: number; estimatedCostUsd: number };
}

export interface SimulationIssue {
  stepIndex: number;
  type: 'missing_tool' | 'invalid_args' | 'missing_dependency' | 'high_risk' | 'budget_risk';
  severity: 'low' | 'medium' | 'high';
  message: string;
}

// --- Multi-Agent Decomposition ---

export interface SubTaskDefinition {
  id: string;
  description: string;
  parentTaskId: string;
  dependsOn: string[];
  budgetShare: number;
  tools?: string[];
}

export interface DecompositionPlan {
  subTasks: SubTaskDefinition[];
  strategy: 'sequential' | 'parallel' | 'mixed';
  aggregation: string;
}

// --- Hybrid Automation Strategy ---

export type AutomationApproach = 'dom' | 'vision' | 'api';

export interface AutomationStrategy {
  primary: AutomationApproach;
  fallbackChain: AutomationApproach[];
  reason: string;
}

// --- Explainability Graph ---

export interface DecisionNode {
  id: string;
  phase: AgentState;
  decision: string;
  rationale: string;
  confidence: number;
  alternatives: string[];
  timestamp: number;
  children: string[];
}

export interface DecisionEdge {
  from: string;
  to: string;
  type: 'caused' | 'led_to' | 'triggered' | 'blocked';
  label?: string;
}

export interface DecisionGraph {
  taskId: string;
  nodes: DecisionNode[];
  edges: DecisionEdge[];
  criticalPath: string[];
}
