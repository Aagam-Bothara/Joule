import { describe, it, expect, beforeEach } from 'vitest';
import { RewardEngine } from '../src/governance/reward-engine.js';
import { TrustManager } from '../src/governance/trust-manager.js';
import type { ViolationRecord, TaskOutcomeForReward } from '@joule/shared';

function makeViolation(overrides?: Partial<ViolationRecord>): ViolationRecord {
  return {
    id: 'v1', agentId: 'agent-1', ruleId: 'R1',
    severity: 'warning', description: 'Test', timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('RewardEngine', () => {
  let tm: TrustManager;
  let engine: RewardEngine;

  beforeEach(() => {
    tm = new TrustManager();
    engine = new RewardEngine(tm);
  });

  describe('rewards', () => {
    it('should reward successful task completion (+0.02)', () => {
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: true, underBudget: false, violations: [],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.type).toBe('reward');
      expect(adj.newScore).toBeCloseTo(0.52, 2);
    });

    it('should add under-budget bonus (+0.01)', () => {
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: true, underBudget: true, violations: [],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.newScore).toBeCloseTo(0.53, 2); // 0.02 + 0.01
    });

    it('should add self-report bonus (+0.03)', () => {
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: true, underBudget: false, violations: [],
        selfReported: true, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.newScore).toBeCloseTo(0.55, 2); // 0.02 + 0.03
    });

    it('should give clean streak bonus at 5 tasks', () => {
      // Record 4 successes (clean streak = 4)
      for (let i = 0; i < 4; i++) {
        engine.evaluateTaskOutcome('agent-1', {
          success: true, underBudget: false, violations: [],
          selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
        });
      }

      // 5th success triggers clean_streak bonus
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: true, underBudget: false, violations: [],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      // 4 × 0.02 = 0.08, then 5th = 0.02 + 0.05 streak = 0.07
      // Total from 0.5: 0.5 + 0.08 + 0.07 = 0.65
      expect(adj.newScore).toBeCloseTo(0.65, 2);
    });
  });

  describe('punishments', () => {
    it('should apply warning for first violation (-0.05)', () => {
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: false, underBudget: false,
        violations: [makeViolation()],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.type).toBe('punishment');
      expect(adj.newScore).toBeCloseTo(0.45, 2);
    });

    it('should escalate to strike with repeated violations (-0.15)', () => {
      // Build up violation history
      const profile = tm.getProfile('agent-1');
      for (let i = 0; i < 3; i++) {
        tm.recordViolation('agent-1', makeViolation({ id: `h${i}` }));
      }

      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: false, underBudget: false,
        violations: [makeViolation({ id: 'current' })],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.newScore).toBeCloseTo(0.35, 2); // warning = -0.15 (4 total → strike)
    });

    it('should apply suspension for serious violation pattern (-0.40)', () => {
      // Build up 7 violations in history
      for (let i = 0; i < 7; i++) {
        tm.recordViolation('agent-1', makeViolation({ id: `h${i}` }));
      }

      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: false, underBudget: false,
        violations: [makeViolation({ id: 'current' })],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.newScore).toBeCloseTo(0.10, 2); // -0.40 suspension
    });

    it('should handle termination-level violations', () => {
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: false, underBudget: false,
        violations: [makeViolation({ severity: 'suspension' })],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      // Suspension severity violation → suspension punishment
      expect(adj.newScore).toBeCloseTo(0.10, 2);
    });
  });

  describe('failure without violations', () => {
    it('should apply small penalty for non-violation failure (-0.01)', () => {
      const adj = engine.evaluateTaskOutcome('agent-1', {
        success: false, underBudget: false, violations: [],
        selfReported: false, toolsUsed: [], durationMs: 1000, costUsd: 0.01,
      });

      expect(adj.newScore).toBeCloseTo(0.49, 2);
    });
  });

  describe('getSeverity', () => {
    it('should return warning for few violations', () => {
      expect(engine.getSeverity([makeViolation()], [])).toBe('warning');
    });

    it('should return strike for 4+ recent violations', () => {
      const history = Array.from({ length: 3 }, (_, i) => makeViolation({ id: `h${i}` }));
      expect(engine.getSeverity([makeViolation()], history)).toBe('strike');
    });

    it('should return suspension for 8+ recent violations', () => {
      const history = Array.from({ length: 7 }, (_, i) => makeViolation({ id: `h${i}` }));
      expect(engine.getSeverity([makeViolation()], history)).toBe('suspension');
    });
  });
});
