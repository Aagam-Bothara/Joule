import { describe, it, expect, beforeEach } from 'vitest';
import { SystemLearner } from '../src/governance/system-learner.js';
import { TrustManager } from '../src/governance/trust-manager.js';
import { PolicyEngine } from '../src/governance/policy-engine.js';

describe('SystemLearner', () => {
  let tm: TrustManager;
  let learner: SystemLearner;

  beforeEach(() => {
    tm = new TrustManager();
    learner = new SystemLearner(tm, undefined, { minDataPoints: 3, analysisIntervalTasks: 5 });
  });

  describe('recordTask', () => {
    it('should trigger analysis at intervals', () => {
      for (let i = 0; i < 4; i++) {
        expect(learner.recordTask()).toBe(false);
      }
      expect(learner.recordTask()).toBe(true); // 5th task triggers
      expect(learner.getTaskCount()).toBe(5);
    });
  });

  describe('analyze', () => {
    it('should detect agents with low trust scores', () => {
      const profile = tm.getProfile('bad-agent');
      profile.totalTasks = 5;
      profile.successfulTasks = 0;
      profile.trustScore = 0.1;
      profile.tier = 'probation';

      const insights = learner.analyze();
      const lowTrust = insights.find(i => i.category === 'task_failure' && i.affectedAgents.includes('bad-agent'));

      expect(lowTrust).toBeDefined();
      expect(lowTrust!.pattern).toContain('probation');
    });

    it('should detect system-wide low success rate', () => {
      // Create agents with low success rates
      for (let i = 0; i < 3; i++) {
        const p = tm.getProfile(`agent-${i}`);
        p.totalTasks = 5;
        p.successfulTasks = 1; // 20% each
      }

      const insights = learner.analyze();
      const systemWide = insights.find(i => i.pattern.includes('System-wide'));

      expect(systemWide).toBeDefined();
      expect(systemWide!.category).toBe('task_failure');
    });

    it('should detect violation hotspots', () => {
      const profile = tm.getProfile('agent-1');
      for (let i = 0; i < 5; i++) {
        profile.violationHistory.push({
          id: `v${i}`, agentId: 'agent-1', ruleId: 'SAFETY-001',
          severity: 'warning', description: 'Test', timestamp: new Date().toISOString(),
        });
      }

      const insights = learner.analyze();
      const hotspot = insights.find(i => i.category === 'violation_hotspot');

      expect(hotspot).toBeDefined();
      expect(hotspot!.pattern).toContain('SAFETY-001');
      expect(hotspot!.dataPoints).toBe(5);
    });

    it('should detect agents with 0% success rate', () => {
      const p = tm.getProfile('zero-agent');
      p.totalTasks = 5;
      p.successfulTasks = 0;

      const insights = learner.analyze();
      const zeroSuccess = insights.find(i => i.category === 'budget_overuse' && i.affectedAgents.includes('zero-agent'));

      expect(zeroSuccess).toBeDefined();
    });

    it('should return empty insights when no data', () => {
      const insights = learner.analyze();
      expect(insights).toHaveLength(0);
    });
  });

  describe('suggestPolicyAdjustments', () => {
    it('should suggest stricter policy for violation hotspots', () => {
      const profile = tm.getProfile('agent-1');
      for (let i = 0; i < 8; i++) {
        profile.violationHistory.push({
          id: `v${i}`, agentId: 'agent-1', ruleId: 'R1',
          severity: 'warning', description: 'Test', timestamp: new Date().toISOString(),
        });
      }

      learner.analyze();
      const suggestions = learner.suggestPolicyAdjustments();

      expect(suggestions.length).toBeGreaterThan(0);
      const hotspotSuggestion = suggestions.find(s => s.newRule?.actions.some(a => a.type === 'require_approval'));
      expect(hotspotSuggestion).toBeDefined();
    });

    it('should suggest budget reduction for failing agents', () => {
      const p = tm.getProfile('fail-agent');
      p.totalTasks = 5;
      p.successfulTasks = 0;

      learner.analyze();
      const suggestions = learner.suggestPolicyAdjustments();

      const budgetSuggestion = suggestions.find(s => s.newRule?.actions.some(a => a.type === 'reduce_budget'));
      expect(budgetSuggestion).toBeDefined();
    });
  });

  describe('applyAdjustment', () => {
    it('should add new rule to policy engine', () => {
      const pe = new PolicyEngine();
      const p = tm.getProfile('fail-agent');
      p.totalTasks = 5;
      p.successfulTasks = 0;

      learner.analyze();
      const suggestions = learner.suggestPolicyAdjustments();

      if (suggestions.length > 0) {
        const applied = learner.applyAdjustment(suggestions[0], pe);
        expect(applied).toBe(true);
        expect(pe.getRules().length).toBeGreaterThan(0);
        expect(learner.getAdjustments()).toHaveLength(1);
      }
    });

    it('should not double-apply adjustments', () => {
      const pe = new PolicyEngine();
      const p = tm.getProfile('fail-agent');
      p.totalTasks = 5;
      p.successfulTasks = 0;

      learner.analyze();
      const suggestions = learner.suggestPolicyAdjustments();

      if (suggestions.length > 0) {
        learner.applyAdjustment(suggestions[0], pe);
        const second = learner.applyAdjustment(suggestions[0], pe);
        expect(second).toBe(false);
      }
    });
  });
});
