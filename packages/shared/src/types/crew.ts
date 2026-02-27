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
}

// ============================================================================
// Orchestration Strategy
// ============================================================================

export type OrchestrationStrategy = 'sequential' | 'parallel' | 'hierarchical' | 'graph';

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
