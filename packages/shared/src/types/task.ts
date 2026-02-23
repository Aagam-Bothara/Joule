import type { BudgetPresetName, BudgetEnvelope, BudgetUsage } from './budget.js';
import type { ExecutionTrace } from './trace.js';
import type { EfficiencyReport } from './energy.js';
import type { SessionMessage } from './session.js';

export interface Task {
  id: string;
  description: string;
  budget?: BudgetPresetName | Partial<BudgetEnvelope>;
  context?: Record<string, unknown>;
  tools?: string[];
  messages?: SessionMessage[];
  sessionId?: string;
  createdAt: string;
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
  type: 'output_check' | 'dom_check' | 'none';
  assertion: string;
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
