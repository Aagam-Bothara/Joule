import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalManager } from '../src/approval-manager.js';
import type { ApprovalPolicy, ApprovalRequest, ApprovalDecision } from '@joule/shared';
import { isoNow } from '@joule/shared';

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'approval_1',
    type: 'tool_call',
    description: 'Execute tool: shell_exec',
    context: {
      toolName: 'shell_exec',
      toolArgs: { command: 'echo hello' },
    },
    createdAt: isoNow(),
    ...overrides,
  };
}

describe('ApprovalManager', () => {
  describe('automatic mode', () => {
    it('should auto-approve everything in automatic mode', async () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      const decision = await manager.requestApproval(makeRequest());
      expect(decision.approved).toBe(true);
      expect(decision.reason).toContain('Auto-approved');
    });

    it('should never need approval in automatic mode', () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      expect(manager.needsApproval('tool_call', { toolName: 'shell_exec' })).toBe(false);
    });
  });

  describe('manual mode', () => {
    it('should require approval for all actions in manual mode', () => {
      const manager = new ApprovalManager({ mode: 'manual' });
      expect(manager.needsApproval('tool_call', { toolName: 'file_read' })).toBe(true);
      expect(manager.needsApproval('agent_handoff', {})).toBe(true);
    });

    it('should respect auto-approve list even in manual mode', () => {
      const manager = new ApprovalManager({
        mode: 'manual',
        autoApproveFor: { toolNames: ['file_read', 'json_transform'] },
      });
      expect(manager.needsApproval('tool_call', { toolName: 'file_read' })).toBe(false);
      expect(manager.needsApproval('tool_call', { toolName: 'shell_exec' })).toBe(true);
    });

    it('should call callback and return decision', async () => {
      const manager = new ApprovalManager({ mode: 'manual' });
      const callback = vi.fn().mockResolvedValue({
        requestId: 'approval_1',
        approved: true,
        reason: 'Looks safe',
        decidedAt: isoNow(),
      } as ApprovalDecision);

      manager.setCallback(callback);
      const decision = await manager.requestApproval(makeRequest());

      expect(callback).toHaveBeenCalledTimes(1);
      expect(decision.approved).toBe(true);
      expect(decision.reason).toBe('Looks safe');
    });

    it('should return denied decision when callback denies', async () => {
      const manager = new ApprovalManager({ mode: 'manual' });
      manager.setCallback(async () => ({
        requestId: 'approval_1',
        approved: false,
        reason: 'Too dangerous',
        decidedAt: isoNow(),
      }));

      const decision = await manager.requestApproval(makeRequest());
      expect(decision.approved).toBe(false);
      expect(decision.reason).toBe('Too dangerous');
    });
  });

  describe('hybrid mode', () => {
    it('should require approval for specified tools', () => {
      const manager = new ApprovalManager({
        mode: 'hybrid',
        requireApprovalFor: { toolNames: ['shell_exec', 'file_write'] },
      });
      expect(manager.needsApproval('tool_call', { toolName: 'shell_exec' })).toBe(true);
      expect(manager.needsApproval('tool_call', { toolName: 'file_read' })).toBe(false);
    });

    it('should require approval for high-risk levels', () => {
      const manager = new ApprovalManager({
        mode: 'hybrid',
        requireApprovalFor: { riskLevels: ['high', 'critical'] },
      });
      expect(manager.needsApproval('tool_call', { toolName: 'x', riskLevel: 'high' })).toBe(true);
      expect(manager.needsApproval('tool_call', { toolName: 'x', riskLevel: 'low' })).toBe(false);
    });

    it('should require approval for agent handoffs when configured', () => {
      const manager = new ApprovalManager({
        mode: 'hybrid',
        requireApprovalFor: { agentHandoffs: true },
      });
      expect(manager.needsApproval('agent_handoff', {})).toBe(true);
      expect(manager.needsApproval('tool_call', { toolName: 'file_read' })).toBe(false);
    });

    it('should require approval when cost exceeds threshold', () => {
      const manager = new ApprovalManager({
        mode: 'hybrid',
        requireApprovalFor: { costThresholdUsd: 1.0 },
      });
      expect(manager.needsApproval('tool_call', {
        toolName: 'shell_exec',
        estimatedCost: 2.0,
      })).toBe(true);
      expect(manager.needsApproval('tool_call', {
        toolName: 'shell_exec',
        estimatedCost: 0.5,
      })).toBe(false);
    });
  });

  describe('timeout', () => {
    it('should deny on approval timeout', async () => {
      const manager = new ApprovalManager({
        mode: 'manual',
        timeoutMs: 50, // 50ms timeout for testing
      });

      // Callback that never resolves
      manager.setCallback(() => new Promise(() => {}));

      const decision = await manager.requestApproval(makeRequest());
      expect(decision.approved).toBe(false);
      expect(decision.reason).toContain('timed out');
    });
  });

  describe('no callback', () => {
    it('should auto-approve when no callback is configured', async () => {
      const manager = new ApprovalManager({ mode: 'manual' });
      // No callback set

      const decision = await manager.requestApproval(makeRequest());
      expect(decision.approved).toBe(true);
      expect(decision.reason).toContain('No approval callback');
    });
  });

  describe('risk assessment', () => {
    it('should assess shell_exec as high risk', () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      const request = manager.createToolCallRequest('shell_exec', { command: 'echo hi' });
      expect(request.context.riskLevel).toBe('high');
    });

    it('should assess rm -rf as critical risk', () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      const request = manager.createToolCallRequest('shell_exec', { command: 'rm -rf /' });
      expect(request.context.riskLevel).toBe('critical');
    });

    it('should assess file_read as low risk', () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      const request = manager.createToolCallRequest('file_read', { path: '/tmp/test.txt' });
      expect(request.context.riskLevel).toBe('low');
    });

    it('should assess http_fetch as medium risk', () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      const request = manager.createToolCallRequest('http_fetch', { url: 'https://example.com' });
      expect(request.context.riskLevel).toBe('medium');
    });
  });

  describe('handoff request', () => {
    it('should create agent handoff request', () => {
      const manager = new ApprovalManager({ mode: 'automatic' });
      const request = manager.createHandoffRequest('researcher', 'writer', 'task_1');
      expect(request.type).toBe('agent_handoff');
      expect(request.context.fromAgentId).toBe('researcher');
      expect(request.context.toAgentId).toBe('writer');
    });
  });
});
