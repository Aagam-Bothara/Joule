import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Governor } from '../src/governance/governor.js';
import { TrustManager } from '../src/governance/trust-manager.js';
import { PolicyEngine } from '../src/governance/policy-engine.js';
import { TieredConstitution } from '../src/governance/tiered-constitution.js';
import { Vault } from '../src/governance/vault.js';
import { AccountabilityChain } from '../src/governance/accountability.js';
import { RewardEngine } from '../src/governance/reward-engine.js';
import { ConsensusMechanism } from '../src/governance/consensus.js';
import { SystemLearner } from '../src/governance/system-learner.js';
import type { Task } from '@joule/shared';

function createMockConstitutionEnforcer() {
  return {
    validateToolCall: vi.fn(() => null),
    validateOutput: vi.fn(() => null),
  };
}

function createGovernor(overrides?: {
  policies?: any[];
  consensusActions?: string[];
}) {
  const trust = new TrustManager();
  const policy = new PolicyEngine(overrides?.policies ?? []);
  const baseConstitution = createMockConstitutionEnforcer();
  const constitution = new TieredConstitution(baseConstitution as any);
  const vault = new Vault();
  const accountability = new AccountabilityChain();
  const rewards = new RewardEngine(trust);
  const consensus = new ConsensusMechanism({
    enabled: true,
    requiredFor: overrides?.consensusActions ?? [],
    votingMode: 'majority',
  });
  const learner = new SystemLearner(trust);

  const governor = new Governor({
    trustManager: trust,
    policyEngine: policy,
    constitution,
    vault,
    accountability,
    rewardEngine: rewards,
    consensus,
    systemLearner: learner,
  });

  return { governor, trust, policy, vault, accountability, consensus };
}

function makeTask(description: string): Task {
  return {
    id: 'task-1',
    description,
    createdAt: new Date().toISOString(),
  };
}

describe('Governor', () => {
  describe('preflight', () => {
    it('should allow standard agents', () => {
      const { governor } = createGovernor();

      const decision = governor.preflight('agent-1', makeTask('Review code'));

      expect(decision.decision).toBe('allow');
      expect(decision.type).toBe('preflight');
      expect(decision.adjustments?.budgetMultiplier).toBe(1.0);
    });

    it('should deny terminated agents', () => {
      const { governor, trust } = createGovernor();
      trust.updateScore('agent-1', -0.5, 'violation'); // score = 0.0
      trust.recordTaskSuccess('agent-1'); // totalTasks > 0

      const decision = governor.preflight('agent-1', makeTask('Do something'));

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('terminated');
    });

    it('should deny when policy blocks', () => {
      const { governor } = createGovernor({
        policies: [{
          id: 'P1', name: 'Block deploy', tier: 'hard', priority: 10,
          conditions: [{ field: 'action', operator: 'eq', value: 'task_start' }],
          actions: [{ type: 'block' }],
        }],
      });

      const decision = governor.preflight('agent-1', makeTask('Deploy to prod'));
      expect(decision.decision).toBe('deny');
    });

    it('should escalate when consensus required', () => {
      const { governor } = createGovernor({
        policies: [{
          id: 'P1', name: 'Consensus for deploy', tier: 'soft', priority: 5,
          conditions: [{ field: 'action', operator: 'eq', value: 'task_start' }],
          actions: [{ type: 'require_consensus' }],
        }],
      });

      const decision = governor.preflight('agent-1', makeTask('Deploy'));
      expect(decision.decision).toBe('escalate');
    });

    it('should apply budget multiplier based on trust tier', () => {
      const { governor, trust } = createGovernor();
      trust.updateScore('agent-1', 0.35, 'task_success'); // score = 0.85 → senior

      const decision = governor.preflight('agent-1', makeTask('Review'));
      expect(decision.adjustments?.budgetMultiplier).toBe(2.0);
    });
  });

  describe('validateToolCall', () => {
    it('should allow normal tool calls', () => {
      const { governor } = createGovernor();

      const decision = governor.validateToolCall('agent-1', { toolName: 'file_read' });

      expect(decision.decision).toBe('allow');
      expect(decision.type).toBe('runtime');
    });

    it('should deny tools blocked by trust profile', () => {
      const { governor, trust } = createGovernor();
      const profile = trust.getProfile('agent-1');
      profile.toolsDenied = ['shell_exec'];

      const decision = governor.validateToolCall('agent-1', { toolName: 'shell_exec' });

      expect(decision.decision).toBe('deny');
      expect(decision.reason).toContain('denied by trust profile');
    });

    it('should deny tools blocked by policy', () => {
      const { governor } = createGovernor({
        policies: [{
          id: 'P1', name: 'Block shell', tier: 'hard', priority: 10,
          conditions: [{ field: 'toolName', operator: 'eq', value: 'shell_exec' }],
          actions: [{ type: 'block' }],
        }],
      });

      const decision = governor.validateToolCall('agent-1', { toolName: 'shell_exec' });
      expect(decision.decision).toBe('deny');
    });

    it('should escalate when consensus required for tool', () => {
      const { governor } = createGovernor({ consensusActions: ['shell_exec'] });

      const decision = governor.validateToolCall('agent-1', { toolName: 'shell_exec' });
      expect(decision.decision).toBe('escalate');
    });

    it('should record violations in accountability chain', () => {
      const { governor, accountability } = createGovernor({
        policies: [{
          id: 'P1', name: 'Block shell', tier: 'hard', priority: 10,
          conditions: [{ field: 'toolName', operator: 'eq', value: 'shell_exec' }],
          actions: [{ type: 'block' }],
        }],
      });

      governor.validateToolCall('agent-1', { toolName: 'shell_exec' });

      const entries = accountability.query({ agentId: 'agent-1', decision: 'deny' });
      expect(entries).toHaveLength(1);
    });
  });

  describe('postTask', () => {
    it('should reward successful tasks', () => {
      const { governor, trust } = createGovernor();

      governor.postTask('agent-1', {
        agentId: 'agent-1',
        role: 'reviewer',
        taskResult: {
          id: 'r1', taskId: 'task-1', traceId: 'tr1',
          status: 'completed',
          result: 'Done',
          stepResults: [],
          budgetUsed: { tokensUsed: 100, tokensRemaining: 900, toolCallsUsed: 1, toolCallsRemaining: 9, escalationsUsed: 0, escalationsRemaining: 1, costUsd: 0.01, costRemaining: 0.09, elapsedMs: 1000, latencyRemaining: 29000, energyWh: 0, carbonGrams: 0 } as any,
          trace: { traceId: 'tr1', taskId: 'task-1', startedAt: '', spans: [], budget: { allocated: {} as any, used: {} as any } },
          completedAt: new Date().toISOString(),
        },
        budgetUsed: {} as any,
        blackboardWrites: [],
      });

      const profile = trust.getProfile('agent-1');
      expect(profile.trustScore).toBeGreaterThan(0.5);
    });

    it('should punish failed tasks with violations', () => {
      const { governor, trust } = createGovernor();

      // First add a recent violation
      trust.recordViolation('agent-1', {
        id: 'v1', agentId: 'agent-1', ruleId: 'R1',
        severity: 'warning', description: 'Bad', timestamp: new Date().toISOString(),
      });

      governor.postTask('agent-1', {
        agentId: 'agent-1',
        role: 'executor',
        taskResult: {
          id: 'r1', taskId: 'task-1', traceId: 'tr1',
          status: 'failed',
          error: 'Something went wrong',
          stepResults: [],
          budgetUsed: { tokensUsed: 100, tokensRemaining: 0, toolCallsUsed: 1, toolCallsRemaining: 0, escalationsUsed: 0, escalationsRemaining: 0, costUsd: 0.01, costRemaining: 0, elapsedMs: 1000, latencyRemaining: 0, energyWh: 0, carbonGrams: 0 } as any,
          trace: { traceId: 'tr1', taskId: 'task-1', startedAt: '', spans: [], budget: { allocated: {} as any, used: {} as any } },
          completedAt: new Date().toISOString(),
        },
        budgetUsed: {} as any,
        blackboardWrites: [],
      });

      const profile = trust.getProfile('agent-1');
      expect(profile.trustScore).toBeLessThan(0.5);
    });

    it('should revoke vault tokens on task completion', () => {
      const { governor, vault } = createGovernor();
      vault.issueToken('agent-1', 'db', ['read']);
      vault.issueToken('agent-1', 'api', ['call']);

      expect(vault.getActiveTokens('agent-1')).toHaveLength(2);

      governor.postTask('agent-1', {
        agentId: 'agent-1', role: 'worker',
        taskResult: {
          id: 'r1', taskId: 'task-1', traceId: 'tr1',
          status: 'completed', result: 'Done', stepResults: [],
          budgetUsed: {} as any,
          trace: { traceId: 'tr1', taskId: 'task-1', startedAt: '', spans: [], budget: { allocated: {} as any, used: {} as any } },
          completedAt: new Date().toISOString(),
        },
        budgetUsed: {} as any,
        blackboardWrites: [],
      });

      expect(vault.getActiveTokens('agent-1')).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should return governance statistics', () => {
      const { governor } = createGovernor();

      governor.preflight('agent-1', makeTask('Review'));
      governor.validateToolCall('agent-1', { toolName: 'file_read' });

      const stats = governor.getStats();
      expect(stats.totalDecisions).toBe(2);
      expect(stats.allowed).toBe(2);
      expect(stats.agentCount).toBe(1);
      expect(stats.averageTrustScore).toBe(0.5);
    });
  });
});
