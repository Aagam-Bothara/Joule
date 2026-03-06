import { describe, it, expect, beforeEach } from 'vitest';
import { AccountabilityChain } from '../src/governance/accountability.js';

describe('AccountabilityChain', () => {
  let chain: AccountabilityChain;

  beforeEach(() => {
    chain = new AccountabilityChain();
  });

  describe('record', () => {
    it('should record an entry and assign id + timestamp', () => {
      const entry = chain.record({
        agentId: 'agent-1',
        action: 'tool_call:shell_exec',
        governorDecision: 'deny',
        policyRuleId: 'R1',
        constitutionRuleId: 'SAFETY-001',
        constitutionTier: 'hard',
        trustScoreAtTime: 0.5,
      });

      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeDefined();
      expect(entry.agentId).toBe('agent-1');
      expect(entry.governorDecision).toBe('deny');
    });

    it('should be append-only', () => {
      chain.record({ agentId: 'a1', action: 'act1', governorDecision: 'allow', trustScoreAtTime: 0.5 });
      chain.record({ agentId: 'a2', action: 'act2', governorDecision: 'deny', trustScoreAtTime: 0.3 });

      expect(chain.size()).toBe(2);
    });
  });

  describe('query', () => {
    beforeEach(() => {
      chain.record({ agentId: 'agent-1', action: 'tool_call', governorDecision: 'allow', trustScoreAtTime: 0.5 });
      chain.record({ agentId: 'agent-1', action: 'tool_call', governorDecision: 'deny', trustScoreAtTime: 0.5 });
      chain.record({ agentId: 'agent-2', action: 'plan', governorDecision: 'allow', trustScoreAtTime: 0.7 });
    });

    it('should filter by agentId', () => {
      const results = chain.query({ agentId: 'agent-1' });
      expect(results).toHaveLength(2);
    });

    it('should filter by decision', () => {
      const results = chain.query({ decision: 'deny' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('agent-1');
    });

    it('should filter by action', () => {
      const results = chain.query({ action: 'plan' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('agent-2');
    });

    it('should return newest first', () => {
      const results = chain.query({});
      expect(results[0].agentId).toBe('agent-2');
      expect(results[2].agentId).toBe('agent-1');
    });

    it('should apply limit', () => {
      const results = chain.query({ limit: 1 });
      expect(results).toHaveLength(1);
    });
  });

  describe('getDenials', () => {
    it('should return only denials for an agent', () => {
      chain.record({ agentId: 'a1', action: 'act1', governorDecision: 'allow', trustScoreAtTime: 0.5 });
      chain.record({ agentId: 'a1', action: 'act2', governorDecision: 'deny', trustScoreAtTime: 0.5 });
      chain.record({ agentId: 'a2', action: 'act3', governorDecision: 'deny', trustScoreAtTime: 0.3 });

      const denials = chain.getDenials('a1');
      expect(denials).toHaveLength(1);
      expect(denials[0].action).toBe('act2');
    });
  });

  describe('getEntry', () => {
    it('should return a specific entry by ID', () => {
      const entry = chain.record({ agentId: 'a1', action: 'act', governorDecision: 'allow', trustScoreAtTime: 0.5 });
      const found = chain.getEntry(entry.id);
      expect(found).toEqual(entry);
    });

    it('should return undefined for unknown ID', () => {
      expect(chain.getEntry('nonexistent')).toBeUndefined();
    });
  });

  describe('toTraceEvents', () => {
    it('should convert entries to trace events', () => {
      chain.record({ agentId: 'a1', action: 'tool_call', governorDecision: 'deny', trustScoreAtTime: 0.5 });

      const events = chain.toTraceEvents('trace-1');
      expect(events).toHaveLength(1);
      expect(events[0].traceId).toBe('trace-1');
      expect(events[0].type).toBe('governance_runtime');
      expect(events[0].data.decision).toBe('deny');
    });
  });
});
