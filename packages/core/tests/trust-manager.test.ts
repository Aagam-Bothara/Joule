import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrustManager } from '../src/governance/trust-manager.js';

function createMockMemory() {
  const facts: any[] = [];
  return {
    storeFact: vi.fn(async (key: string, value: any, category: string, source: string) => {
      facts.push({ key, value, category, source });
    }),
    searchFacts: vi.fn(async () => facts),
    _facts: facts,
  };
}

describe('TrustManager', () => {
  let tm: TrustManager;

  beforeEach(() => {
    tm = new TrustManager();
  });

  describe('getProfile', () => {
    it('should create a default profile for new agents', () => {
      const profile = tm.getProfile('agent-1');

      expect(profile.agentId).toBe('agent-1');
      expect(profile.trustScore).toBe(0.5);
      expect(profile.tier).toBe('standard');
      expect(profile.budgetMultiplier).toBe(1.0);
      expect(profile.oversightLevel).toBe('standard');
      expect(profile.streaks).toEqual({ clean: 0, violation: 0 });
    });

    it('should return the same profile on subsequent calls', () => {
      const p1 = tm.getProfile('agent-1');
      const p2 = tm.getProfile('agent-1');
      expect(p1).toBe(p2);
    });
  });

  describe('computeTier', () => {
    it('should assign probation for scores below 0.3', () => {
      expect(tm.computeTier(0.0)).toBe('probation');
      expect(tm.computeTier(0.29)).toBe('probation');
    });

    it('should assign standard for scores 0.3–0.6', () => {
      expect(tm.computeTier(0.3)).toBe('standard');
      expect(tm.computeTier(0.59)).toBe('standard');
    });

    it('should assign trusted for scores 0.6–0.8', () => {
      expect(tm.computeTier(0.6)).toBe('trusted');
      expect(tm.computeTier(0.79)).toBe('trusted');
    });

    it('should assign senior for scores 0.8+', () => {
      expect(tm.computeTier(0.8)).toBe('senior');
      expect(tm.computeTier(1.0)).toBe('senior');
    });
  });

  describe('updateScore', () => {
    it('should increase score on reward', () => {
      const adj = tm.updateScore('agent-1', 0.1, 'task_success');

      expect(adj.type).toBe('reward');
      expect(adj.delta).toBe(0.1);
      expect(adj.oldScore).toBe(0.5);
      expect(adj.newScore).toBe(0.6);
      expect(adj.oldTier).toBe('standard');
      expect(adj.newTier).toBe('trusted');
    });

    it('should decrease score on punishment', () => {
      const adj = tm.updateScore('agent-1', -0.3, 'violation');

      expect(adj.type).toBe('punishment');
      expect(adj.newScore).toBe(0.2);
      expect(adj.newTier).toBe('probation');
    });

    it('should clamp score to [0, 1]', () => {
      tm.updateScore('agent-1', 0.6, 'task_success'); // 0.5 + 0.6 = 1.1 → 1.0
      expect(tm.getProfile('agent-1').trustScore).toBe(1.0);

      tm.updateScore('agent-1', -2.0, 'violation'); // 1.0 - 2.0 = -1.0 → 0.0
      expect(tm.getProfile('agent-1').trustScore).toBe(0.0);
    });

    it('should update budget multiplier and oversight on tier change', () => {
      tm.updateScore('agent-1', 0.35, 'task_success'); // 0.5 + 0.35 = 0.85 → senior
      const profile = tm.getProfile('agent-1');

      expect(profile.tier).toBe('senior');
      expect(profile.budgetMultiplier).toBe(2.0);
      expect(profile.oversightLevel).toBe('none');
    });
  });

  describe('recordViolation', () => {
    it('should add violation to history and reset clean streak', () => {
      tm.recordTaskSuccess('agent-1'); // clean = 1
      tm.recordViolation('agent-1', {
        id: 'v1', agentId: 'agent-1', ruleId: 'SAFETY-001',
        severity: 'strike', description: 'Bad tool call', timestamp: new Date().toISOString(),
      });

      const profile = tm.getProfile('agent-1');
      expect(profile.violationHistory).toHaveLength(1);
      expect(profile.streaks.clean).toBe(0);
      expect(profile.streaks.violation).toBe(1);
    });

    it('should cap violation history at 50', () => {
      for (let i = 0; i < 55; i++) {
        tm.recordViolation('agent-1', {
          id: `v${i}`, agentId: 'agent-1', ruleId: 'R1',
          severity: 'warning', description: `Violation ${i}`, timestamp: new Date().toISOString(),
        });
      }
      expect(tm.getProfile('agent-1').violationHistory).toHaveLength(50);
    });
  });

  describe('recordTaskSuccess / recordTaskFailure', () => {
    it('should track task counts and streaks', () => {
      tm.recordTaskSuccess('agent-1');
      tm.recordTaskSuccess('agent-1');
      tm.recordTaskFailure('agent-1');

      const profile = tm.getProfile('agent-1');
      expect(profile.totalTasks).toBe(3);
      expect(profile.successfulTasks).toBe(2);
      expect(profile.streaks.clean).toBe(2); // failure doesn't reset clean streak (only violations do)
    });
  });

  describe('isToolAllowed', () => {
    it('should deny tools in the denied list', () => {
      const profile = tm.getProfile('agent-1');
      profile.toolsDenied = ['shell_exec'];

      expect(tm.isToolAllowed('agent-1', 'shell_exec')).toBe(false);
      expect(tm.isToolAllowed('agent-1', 'file_read')).toBe(true);
    });
  });

  describe('persist / hydrate', () => {
    it('should persist profiles to memory', async () => {
      const memory = createMockMemory();
      const tm2 = new TrustManager(memory as any);
      tm2.getProfile('agent-1');
      tm2.updateScore('agent-1', 0.1, 'task_success');

      await tm2.persist();

      expect(memory.storeFact).toHaveBeenCalledWith(
        'trust-profile:agent-1',
        expect.objectContaining({ agentId: 'agent-1', trustScore: 0.6 }),
        'trust-profiles',
        'trust-manager',
      );
    });

    it('should hydrate profiles from memory', async () => {
      const memory = createMockMemory();
      memory._facts.push({
        key: 'trust-profile:agent-x',
        value: { agentId: 'agent-x', trustScore: 0.9, tier: 'senior' } as any,
        category: 'trust-profiles',
      });

      const tm2 = new TrustManager(memory as any);
      await tm2.hydrate();

      const profile = tm2.getProfile('agent-x');
      expect(profile.trustScore).toBe(0.9);
    });

    it('should not overwrite in-session data on hydrate', async () => {
      const memory = createMockMemory();
      memory._facts.push({
        key: 'trust-profile:agent-1',
        value: { agentId: 'agent-1', trustScore: 0.3, tier: 'standard' } as any,
        category: 'trust-profiles',
      });

      const tm2 = new TrustManager(memory as any);
      tm2.getProfile('agent-1'); // creates with 0.5
      await tm2.hydrate();

      expect(tm2.getProfile('agent-1').trustScore).toBe(0.5); // in-session wins
    });
  });

  describe('custom config', () => {
    it('should respect custom default trust score', () => {
      const tm2 = new TrustManager(undefined, { enabled: true, defaultTrustScore: 0.8 });
      const profile = tm2.getProfile('agent-1');
      expect(profile.trustScore).toBe(0.8);
      expect(profile.tier).toBe('senior');
    });

    it('should respect custom thresholds', () => {
      const tm2 = new TrustManager(undefined, {
        enabled: true,
        trustThresholds: { probation: 0.2, trusted: 0.5, senior: 0.9 },
      });
      expect(tm2.computeTier(0.19)).toBe('probation');
      expect(tm2.computeTier(0.3)).toBe('standard');
      expect(tm2.computeTier(0.5)).toBe('trusted');
      expect(tm2.computeTier(0.9)).toBe('senior');
    });
  });
});
