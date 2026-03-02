/**
 * Human-in-the-Loop (HITL) approval types.
 *
 * Defines the approval request/decision/policy system that enables
 * human oversight of tool execution, agent handoffs, and plan revisions.
 */

/** Categories of actions that may require approval. */
export type ApprovalType =
  | 'tool_call'
  | 'agent_handoff'
  | 'plan_revision'
  | 'budget_threshold';

/** Approval workflow modes. */
export type ApprovalMode =
  | 'automatic'   // No human approval needed (default — backward-compatible)
  | 'manual'      // All qualifying actions require approval
  | 'hybrid';     // Only high-risk or policy-matching actions require approval

/** An approval request emitted when a qualifying action is about to execute. */
export interface ApprovalRequest {
  id: string;
  type: ApprovalType;
  description: string;
  context: {
    taskId?: string;
    agentId?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    estimatedCost?: number;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    fromAgentId?: string;
    toAgentId?: string;
  };
  createdAt: string;
}

/** A human decision on an approval request. */
export interface ApprovalDecision {
  requestId: string;
  approved: boolean;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
  decidedBy?: string;
  decidedAt: string;
}

/** Configuration for the approval system. */
export interface ApprovalPolicy {
  /** Approval workflow mode (default: 'automatic'). */
  mode: ApprovalMode;

  /** Actions that require approval. */
  requireApprovalFor?: {
    /** Specific tool names that always require approval. */
    toolNames?: string[];
    /** Risk levels that require approval (e.g., ['high', 'critical']). */
    riskLevels?: string[];
    /** Actions with estimated cost above this USD threshold require approval. */
    costThresholdUsd?: number;
    /** Require approval at crew agent handoff points. */
    agentHandoffs?: boolean;
    /** Require approval when the planner revises a plan. */
    planRevisions?: boolean;
  };

  /** Actions that are auto-approved even in manual mode. */
  autoApproveFor?: {
    /** Tools that never need approval (safe-list). */
    toolNames?: string[];
    /** Risk levels that are auto-approved (e.g., ['low']). */
    riskLevels?: string[];
  };

  /** Timeout in ms before auto-denying (default: 300_000 = 5 min). */
  timeoutMs?: number;
}

/**
 * Async callback that the host provides to handle approval requests.
 * Resolves when the human makes a decision.
 */
export type ApprovalCallback = (request: ApprovalRequest) => Promise<ApprovalDecision>;
