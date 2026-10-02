import type { BudgetPresetName, BudgetEnvelope, BudgetUsage } from './budget.js';
import type { ExecutionTrace } from './trace.js';
import type { EfficiencyReport } from './energy.js';
import type { TaskResult } from './task.js';

// ============================================================================
// Agent Definition
// ============================================================================

/**
 * Defines a single agent within a crew.
 * Each agent has a role, system instructions, allowed tools, and budget share.
 */
export interface AgentDefinition {
  /** Unique identifier within the crew (e.g., 'researcher', 'writer') */
  id: string;

  /** Human-readable role name (e.g., 'Research Analyst') */
  role: string;

  /** System prompt injected into the Planner — defines personality and approach */
  instructions: string;

  /**
   * Tool whitelist. If undefined or empty, agent gets ALL tools from the registry.
   * Names must match registered tool names.
   */
  allowedTools?: string[];

  /**
   * Fraction of the crew's total budget allocated to this agent (0.0–1.0).
   * If omitted, budget is split equally among agents.
   */
  budgetShare?: number;

  /**
   * Memory sharing mode:
   * - 'shared': reads/writes session-level memory (default)
   * - 'isolated': reads shared semantic facts but tags episodic writes with agent ID
   * - 'none': no memory access (stateless)
   */
  memoryMode?: 'shared' | 'isolated' | 'none';

  /** Max retry attempts on failure (default: 0 = no retry) */
  maxRetries?: number;

  /** Base delay between retries in ms (default: 1000). Doubles each attempt. */
  retryDelayMs?: number;

  /** JSON Schema that the agent's output must conform to. Validated after execution. */
  outputSchema?: Record<string, unknown>;

  /**
   * Execution mode for the agent:
   * - 'direct': Fast reactive loop (LLM → tool → result → repeat). 1-3 LLM calls. (default)
   * - 'full': Full 7-phase pipeline (spec → plan → execute → synthesize). 4+ LLM calls.
   *
   * Use 'direct' for agents with clear instructions and tool-based tasks (OpenClaw-style).
   * Use 'full' for complex reasoning tasks that benefit from structured planning.
   */
  executionMode?: 'direct' | 'full';

  /** Max iterations for direct execution mode (default: 10). Prevents infinite loops. */
  maxIterations?: number;

  /**
   * Wall-clock limit for one direct-mode run, in ms (default: 5 minutes).
   *
   * The default suits an interactive agent. A benchmark whose agents read
   * several files before acting may need longer, and needs to say so rather
   * than have runs end for a reason unrelated to what it is measuring.
   */
  wallTimeoutMs?: number;

  /**
   * Output token cap per model reply in direct mode (default: 4096).
   *
   * A reply that writes a file carries the whole edit, and reasoning models
   * spend part of the cap before writing anything. Provider defaults (often
   * 1024) cut such replies off mid-call.
   */
  maxOutputTokens?: number;
}

// ============================================================================
// Orchestration Strategy
// ============================================================================

/**
 * `staged_recovery` runs the first agent, checks the task's external verifier,
 * and only starts the next agent if that check fails. Crew width becomes a
 * consequence of failing verification rather than something chosen up front.
 * It requires `task.verifiedEdit`, since the decision to escalate must come
 * from outside the agent's own belief that it finished.
 */
/**
 * `verified_full` is `staged_recovery` with early stopping switched off: every
 * stage runs, and every stage is still followed by the check whose result is
 * handed to the next agent. It exists to separate the two things staged
 * recovery changes at once — giving specialists the verifier's evidence, and
 * declining to run them at all — by holding the first and dropping the second.
 */
export type OrchestrationStrategy =
  | 'sequential' | 'parallel' | 'hierarchical' | 'graph' | 'staged_recovery' | 'verified_full';

/** Why a staged-recovery stage did not run. */
export type StageSkipReason = 'verification_already_passed';

/** One stage of a staged-recovery crew, run or skipped. */
export interface StageReport {
  /** 1-based position in the escalation order */
  stage: number;
  agentId: string;
  role: string;
  executed: boolean;
  /** Set only when `executed` is false */
  skipReason?: StageSkipReason;
  status?: string;
  error?: string;
  modelCalls?: number;
  toolCalls?: number;
  proposedWrites?: number;
  acceptedWrites?: number;
  rolledBackWrites?: number;
  tokensUsed?: number;
  costUsd?: number;
  /** The external check after this stage ran */
  verification?: { passed: boolean; output: string };
}

/** What a staged-recovery crew did, and which stage settled it. */
export interface StagedRecoveryReport {
  stagesExecuted: number;
  /** 1-based stage whose verification passed; absent if none did */
  solvedAtStage?: number;
  solvedByRole?: string;
  /** Final state of the external verifier */
  verified: boolean;
  /** Every stage in escalation order, including the ones never started */
  stages: StageReport[];
}

// ============================================================================
// Crew Definition
// ============================================================================

/**
 * Defines a crew of agents and how they collaborate.
 */
export interface CrewDefinition {
  /** Unique name for this crew (e.g., 'content-pipeline') */
  name: string;

  /** Human-readable description */
  description?: string;

  /** The agents in this crew */
  agents: AgentDefinition[];

  /** How agents are orchestrated */
  strategy: OrchestrationStrategy;

  /**
   * Override execution order (agent IDs).
   * - sequential: agent pipeline order
   * - hierarchical: first ID is the manager, rest are workers
   * - parallel/graph: ignored
   */
  agentOrder?: string[];

  /** DAG edges for 'graph' strategy */
  graph?: GraphEdge[];

  /** Budget for the entire crew */
  budget?: BudgetPresetName | Partial<BudgetEnvelope>;

  /**
   * How `budget` is divided among the agents.
   *
   * - 'share' (default): the crew budget is split by `budgetShare`, so the
   *   crew as a whole is capped and each extra agent shrinks the others.
   * - 'fixed_per_agent': every agent gets the crew budget as its own ceiling,
   *   so adding an agent adds capacity instead of taking it from the agents
   *   already there.
   *
   * The second mode exists for experiments that vary crew size: under 'share'
   * an implementer at width 1 gets three times the tokens it gets at width 3,
   * which makes crew width and per-agent budget the same variable. Production
   * crews keep the capped default unless they opt in.
   */
  budgetMode?: 'share' | 'fixed_per_agent';

  /** How to combine agent results into the final output */
  aggregation?: 'concat' | 'last' | 'custom';

  /** Custom aggregation prompt (used when aggregation is 'custom') */
  aggregationPrompt?: string;
}

// ============================================================================
// Graph Edge (DAG orchestration)
// ============================================================================

/**
 * A directed edge in the crew execution graph.
 * After `from` agent completes, `to` agent executes (if condition is met).
 */
export interface GraphEdge {
  /** Source agent ID (prerequisite) */
  from: string;

  /** Target agent ID (runs after source) */
  to: string;

  /**
   * Optional condition evaluated against blackboard/results.
   * Simple patterns only (no eval):
   * - 'agent_id.status === "completed"'
   * - 'blackboard.key'
   * - 'blackboard.key === "value"'
   * If undefined, edge is unconditional.
   */
  condition?: string;
}

// ============================================================================
// Blackboard (Inter-Agent Communication)
// ============================================================================

/** Shared key-value state between agents — the primary communication mechanism. */
export interface Blackboard {
  entries: Record<string, BlackboardEntry>;
}

export interface BlackboardEntry {
  /** Which agent wrote this entry */
  agentId: string;

  /** The value (agent result text, structured data, etc.) */
  value: unknown;

  /** When this entry was written */
  timestamp: string;

  /** Agent execution status when this entry was written */
  status?: 'pending' | 'running' | 'completed' | 'failed';

  /** Optional structured metadata */
  metadata?: BlackboardMetadata;
}

export interface BlackboardMetadata {
  /** Agent confidence in its output (0.0–1.0) */
  confidence?: number;
  /** Tags for filtering/routing */
  tags?: string[];
  /** Output format hint (e.g., 'json', 'markdown', 'text') */
  format?: string;
}

// ============================================================================
// Crew Execution Results
// ============================================================================

/** Result of executing a single agent within a crew */
export interface AgentResult {
  /** Agent definition ID */
  agentId: string;

  /** Agent role name */
  role: string;

  /** The underlying TaskResult from the TaskExecutor */
  taskResult: TaskResult;

  /** Budget consumed by this specific agent */
  budgetUsed: BudgetUsage;

  /** Keys this agent wrote to the blackboard */
  blackboardWrites: string[];
}

/** Result of executing an entire crew */
export interface CrewResult {
  /** Unique ID for this crew execution */
  id: string;

  /** Name of the crew that was executed */
  crewName: string;

  /** Overall execution status */
  status: 'completed' | 'partial' | 'failed';

  /** Aggregated final result from all agents */
  result?: string;

  /** Per-agent results, in execution order */
  agentResults: AgentResult[];

  /** Total budget consumed by the entire crew */
  budgetUsed: BudgetUsage;

  /** Combined execution trace */
  trace: ExecutionTrace;

  /** Efficiency report for the entire crew */
  efficiencyReport?: EfficiencyReport;

  /** Final state of the shared blackboard */
  blackboard: Blackboard;

  /** Crew completion timestamp */
  completedAt: string;

  /** Error message if crew failed */
  error?: string;

  /**
   * Present only for `staged_recovery`. `agentResults` still holds just the
   * agents that ran, so a stage that was never needed is recorded here rather
   * than faked as a completed agent that did no work.
   */
  staged?: StagedRecoveryReport;
}

// ============================================================================
// Crew Streaming Events
// ============================================================================

export type CrewStreamEventType =
  | 'agent-start'
  | 'agent-progress'
  | 'agent-complete'
  | 'agent-error'
  | 'crew-complete';

/** Event emitted during crew streaming execution */
export interface CrewStreamEvent {
  type: CrewStreamEventType;
  agentId?: string;
  agentRole?: string;
  progress?: { phase: string; stepIndex?: number; totalSteps?: number };
  agentResult?: AgentResult;
  crewResult?: CrewResult;
  timestamp: string;
}
