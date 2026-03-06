import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyEngine } from '../src/governance/policy-engine.js';
import type { PolicyRule, PolicyContext } from '@joule/shared';

function makeRule(overrides: Partial<PolicyRule> & { id: string }): PolicyRule {
  return {
    name: overrides.id,
    tier: 'soft',
    conditions: [],
    actions: [{ type: 'log' }],
    priority: 0,
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  let engine: PolicyEngine;

  const baseContext: PolicyContext = {
    agentId: 'agent-1',
    taskType: 'code-review',
    toolName: 'file_read',
    trustTier: 'standard',
    trustScore: 0.5,
  };

  beforeEach(() => {
    engine = new PolicyEngine();
  });

  describe('evaluate', () => {
    it('should return empty actions when no rules match', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'taskType', operator: 'eq', value: 'deploy' }],
        actions: [{ type: 'block' }],
      }));

      const actions = engine.evaluate(baseContext);
      expect(actions).toHaveLength(0);
    });

    it('should match eq condition', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'taskType', operator: 'eq', value: 'code-review' }],
        actions: [{ type: 'log' }],
      }));

      const actions = engine.evaluate(baseContext);
      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('log');
    });

    it('should match neq condition', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'trustTier', operator: 'neq', value: 'senior' }],
        actions: [{ type: 'require_approval' }],
      }));

      const actions = engine.evaluate(baseContext);
      expect(actions[0].type).toBe('require_approval');
    });

    it('should match numeric gt/lt conditions', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'trustScore', operator: 'lt', value: 0.6 }],
        actions: [{ type: 'reduce_budget' }],
      }));

      const actions = engine.evaluate(baseContext);
      expect(actions[0].type).toBe('reduce_budget');
    });

    it('should match in condition', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'toolName', operator: 'in', value: ['shell_exec', 'file_write'] }],
        actions: [{ type: 'block' }],
      }));

      expect(engine.evaluate(baseContext)).toHaveLength(0); // file_read not in list

      const shellContext = { ...baseContext, toolName: 'shell_exec' };
      const actions = engine.evaluate(shellContext);
      expect(actions[0].type).toBe('block');
    });

    it('should match regex condition', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'toolName', operator: 'matches', value: '^shell_' }],
        actions: [{ type: 'require_approval' }],
      }));

      const shellContext = { ...baseContext, toolName: 'shell_exec' };
      expect(engine.evaluate(shellContext)[0].type).toBe('require_approval');
      expect(engine.evaluate(baseContext)).toHaveLength(0);
    });

    it('should require ALL conditions to match', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [
          { field: 'taskType', operator: 'eq', value: 'code-review' },
          { field: 'trustTier', operator: 'eq', value: 'probation' },
        ],
        actions: [{ type: 'block' }],
      }));

      // Only taskType matches, not trustTier
      expect(engine.evaluate(baseContext)).toHaveLength(0);

      // Both match
      const probationContext = { ...baseContext, trustTier: 'probation' as const };
      expect(engine.evaluate(probationContext)[0].type).toBe('block');
    });
  });

  describe('conflict resolution', () => {
    it('should prefer hard tier over soft tier', () => {
      engine.addRule(makeRule({
        id: 'R1', tier: 'soft', priority: 10,
        conditions: [{ field: 'toolName', operator: 'eq', value: 'file_read' }],
        actions: [{ type: 'allow' }],
      }));
      engine.addRule(makeRule({
        id: 'R2', tier: 'hard', priority: 1,
        conditions: [{ field: 'toolName', operator: 'eq', value: 'file_read' }],
        actions: [{ type: 'block' }],
      }));

      const actions = engine.evaluate(baseContext);
      // Both match, but block (hard) beats allow (soft) — both appear, block first
      expect(actions[0].type).toBe('block');
    });

    it('should prefer higher priority within same tier', () => {
      engine.addRule(makeRule({
        id: 'R1', tier: 'soft', priority: 5,
        actions: [{ type: 'log' }],
        conditions: [{ field: 'agentId', operator: 'eq', value: 'agent-1' }],
      }));
      engine.addRule(makeRule({
        id: 'R2', tier: 'soft', priority: 10,
        actions: [{ type: 'log', params: { level: 'warn' } }],
        conditions: [{ field: 'agentId', operator: 'eq', value: 'agent-1' }],
      }));

      const actions = engine.evaluate(baseContext);
      // Same action type → deduplicated, higher priority wins
      expect(actions).toHaveLength(1);
      expect(actions[0].params).toEqual({ level: 'warn' });
    });
  });

  describe('addRule / removeRule', () => {
    it('should add and remove rules', () => {
      engine.addRule(makeRule({ id: 'R1' }));
      expect(engine.getRules()).toHaveLength(1);

      engine.removeRule('R1');
      expect(engine.getRules()).toHaveLength(0);
    });

    it('should return false when removing non-existent rule', () => {
      expect(engine.removeRule('nonexistent')).toBe(false);
    });
  });

  describe('getMatchingRuleIds', () => {
    it('should return IDs of matching rules', () => {
      engine.addRule(makeRule({
        id: 'R1',
        conditions: [{ field: 'agentId', operator: 'eq', value: 'agent-1' }],
      }));
      engine.addRule(makeRule({
        id: 'R2',
        conditions: [{ field: 'agentId', operator: 'eq', value: 'agent-2' }],
      }));

      const ids = engine.getMatchingRuleIds(baseContext);
      expect(ids).toEqual(['R1']);
    });
  });

  describe('constructor with initial rules', () => {
    it('should accept rules in constructor', () => {
      const pe = new PolicyEngine([
        makeRule({ id: 'R1', conditions: [] }),
        makeRule({ id: 'R2', conditions: [] }),
      ]);
      expect(pe.getRules()).toHaveLength(2);
    });
  });
});
