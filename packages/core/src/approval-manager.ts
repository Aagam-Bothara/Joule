/**
 * ApprovalManager — Human-in-the-Loop (HITL) approval system.
 *
 * Provides configurable approval workflows for tool calls, agent handoffs,
 * plan revisions, and budget threshold crossings. Integrates with ToolRegistry
 * via the same pattern as ConstitutionEnforcer (setApprovalManager).
 */

import {
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalDecision,
  type ApprovalCallback,
  type ApprovalType,
  generateId,
  isoNow,
} from '@joule/shared';

/** Risk assessment for a tool call based on tool name and arguments. */
const HIGH_RISK_TOOLS = new Set([
  'shell_exec', 'file_write', 'os_keyboard', 'os_mouse',
  'os_open', 'os_clipboard',
]);

const CRITICAL_RISK_PATTERNS = [
  /rm\s+-rf/i, /del\s+\/[sq]/i, /format\s+[a-z]:/i,
  /drop\s+table/i, /truncate/i, /shutdown/i,
];

export class ApprovalManager {
  private callback?: ApprovalCallback;

  constructor(private policy: ApprovalPolicy) {}

  /** Set the approval callback that will be invoked for approval requests. */
  setCallback(callback: ApprovalCallback): void {
    this.callback = callback;
  }

  /** Check if an action of the given type needs approval based on the current policy. */
  needsApproval(type: ApprovalType, context: ApprovalRequest['context']): boolean {
    // Automatic mode: never ask
    if (this.policy.mode === 'automatic') return false;

    const req = this.policy.requireApprovalFor;
    const auto = this.policy.autoApproveFor;

    // Check auto-approve list first
    if (auto) {
      if (type === 'tool_call' && context.toolName) {
        if (auto.toolNames?.includes(context.toolName)) return false;
        if (context.riskLevel && auto.riskLevels?.includes(context.riskLevel)) return false;
      }
    }

    // Manual mode: require approval for everything not auto-approved
    if (this.policy.mode === 'manual') return true;

    // Hybrid mode: check specific conditions
    if (!req) return false;

    if (type === 'tool_call' && context.toolName) {
      if (req.toolNames?.includes(context.toolName)) return true;
      if (context.riskLevel && req.riskLevels?.includes(context.riskLevel)) return true;
      if (req.costThresholdUsd !== undefined && context.estimatedCost !== undefined) {
        if (context.estimatedCost >= req.costThresholdUsd) return true;
      }
    }

    if (type === 'agent_handoff' && req.agentHandoffs) return true;
    if (type === 'plan_revision' && req.planRevisions) return true;

    return false;
  }

  /**
   * Request approval for an action. Returns the decision.
   * If no callback is set, auto-approves (graceful degradation).
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    // Assess risk level if not already set
    if (!request.context.riskLevel) {
      request.context.riskLevel = this.assessRisk(
        request.context.toolName,
        request.context.toolArgs,
      );
    }

    // Check if this action actually needs approval
    if (!this.needsApproval(request.type, request.context)) {
      return {
        requestId: request.id,
        approved: true,
        reason: 'Auto-approved by policy',
        decidedAt: isoNow(),
      };
    }

    // No callback = auto-approve (graceful degradation for programmatic use)
    if (!this.callback) {
      return {
        requestId: request.id,
        approved: true,
        reason: 'No approval callback configured — auto-approved',
        decidedAt: isoNow(),
      };
    }

    // Request approval with timeout
    const timeoutMs = this.policy.timeoutMs ?? 300_000;

    try {
      const decision = await Promise.race([
        this.callback(request),
        new Promise<ApprovalDecision>((_, reject) =>
          setTimeout(() => reject(new Error('Approval timeout')), timeoutMs),
        ),
      ]);
      return decision;
    } catch {
      return {
        requestId: request.id,
        approved: false,
        reason: `Approval timed out after ${Math.round(timeoutMs / 1000)}s`,
        decidedAt: isoNow(),
      };
    }
  }

  /**
   * Create an approval request for a tool call.
   * Convenience method that builds the ApprovalRequest structure.
   */
  createToolCallRequest(
    toolName: string,
    toolArgs: Record<string, unknown>,
    taskId?: string,
  ): ApprovalRequest {
    return {
      id: generateId('approval'),
      type: 'tool_call',
      description: `Execute tool: ${toolName}`,
      context: {
        taskId,
        toolName,
        toolArgs,
        riskLevel: this.assessRisk(toolName, toolArgs),
      },
      createdAt: isoNow(),
    };
  }

  /**
   * Create an approval request for an agent handoff.
   */
  createHandoffRequest(
    fromAgentId: string,
    toAgentId: string,
    taskId?: string,
  ): ApprovalRequest {
    return {
      id: generateId('approval'),
      type: 'agent_handoff',
      description: `Agent handoff: ${fromAgentId} → ${toAgentId}`,
      context: {
        taskId,
        fromAgentId,
        toAgentId,
        riskLevel: 'medium',
      },
      createdAt: isoNow(),
    };
  }

  /** Assess the risk level of a tool call. */
  private assessRisk(
    toolName?: string,
    toolArgs?: Record<string, unknown>,
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (!toolName) return 'low';

    // Check for critical patterns in arguments
    if (toolArgs) {
      const argsStr = JSON.stringify(toolArgs);
      for (const pattern of CRITICAL_RISK_PATTERNS) {
        if (pattern.test(argsStr)) return 'critical';
      }
    }

    // High-risk tools
    if (HIGH_RISK_TOOLS.has(toolName)) return 'high';

    // Network tools are medium risk
    if (toolName === 'http_fetch' || toolName.startsWith('browser_')) return 'medium';

    return 'low';
  }
}
