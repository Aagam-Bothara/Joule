import { describe, it, expect, beforeEach } from 'vitest';
import { EnhancedRateLimiter } from '../src/rate-limiter.js';

describe('EnhancedRateLimiter', () => {
  let limiter: EnhancedRateLimiter;

  beforeEach(() => {
    limiter = new EnhancedRateLimiter({
      tiers: {
        default: { name: 'default', requestsPerMinute: 5 },
        admin: { name: 'admin', requestsPerMinute: 100 },
        premium: { name: 'premium', requestsPerMinute: 20, costPerMinuteUsd: 1.0 },
      },
      defaultTier: 'default',
    });
  });

  describe('basic rate limiting', () => {
    it('should allow requests under limit', () => {
      const result = limiter.check('user1', 'default', '/tasks');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('should deny requests over limit', () => {
      for (let i = 0; i < 5; i++) {
        limiter.record('user1', '/tasks');
      }

      const result = limiter.check('user1', 'default', '/tasks');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('tiered limits', () => {
    it('should apply higher limits for admin tier', () => {
      for (let i = 0; i < 10; i++) {
        limiter.record('admin1', '/tasks');
      }

      const result = limiter.check('admin1', 'admin', '/tasks');
      expect(result.allowed).toBe(true);
    });

    it('should fall back to default tier for unknown roles', () => {
      for (let i = 0; i < 5; i++) {
        limiter.record('user1', '/tasks');
      }

      const result = limiter.check('user1', 'unknown_role', '/tasks');
      expect(result.allowed).toBe(false);
    });
  });

  describe('cost-based limiting', () => {
    it('should deny when cost exceeds per-minute limit', () => {
      limiter.record('premium1', '/tasks', 0.8);

      const result = limiter.check('premium1', 'premium', '/tasks', 0.3);
      expect(result.allowed).toBe(false);
    });

    it('should allow when cost is under limit', () => {
      limiter.record('premium1', '/tasks', 0.2);

      const result = limiter.check('premium1', 'premium', '/tasks', 0.3);
      expect(result.allowed).toBe(true);
    });
  });

  describe('per-endpoint limits', () => {
    it('should apply per-endpoint overrides', () => {
      const limiterWithEndpoint = new EnhancedRateLimiter({
        tiers: { default: { name: 'default', requestsPerMinute: 100 } },
        defaultTier: 'default',
        perEndpoint: { '/tasks/stream': { requestsPerMinute: 3 } },
      });

      for (let i = 0; i < 3; i++) {
        limiterWithEndpoint.record('user1', '/tasks/stream');
      }

      const result = limiterWithEndpoint.check('user1', 'default', '/tasks/stream');
      expect(result.allowed).toBe(false);

      // Regular endpoint should still be allowed
      const normalResult = limiterWithEndpoint.check('user1', 'default', '/tasks');
      expect(normalResult.allowed).toBe(true);
    });
  });

  describe('adaptive throttling', () => {
    it('should return multiplier between 0.5 and 1.0', () => {
      const adaptiveLimiter = new EnhancedRateLimiter({
        tiers: { default: { name: 'default', requestsPerMinute: 60 } },
        defaultTier: 'default',
        adaptiveEnabled: true,
      });

      const multiplier = adaptiveLimiter.getAdaptiveMultiplier();
      expect(multiplier).toBeGreaterThanOrEqual(0.5);
      expect(multiplier).toBeLessThanOrEqual(1.0);
    });
  });

  describe('bucket reset', () => {
    it('should provide a future reset time', () => {
      const result = limiter.check('user1', 'default', '/tasks');
      expect(result.resetAt).toBeGreaterThan(Date.now());
    });
  });

  describe('getTier', () => {
    it('should return the tier for a known role', () => {
      const tier = limiter.getTier('admin');
      expect(tier).toBeDefined();
      expect(tier!.requestsPerMinute).toBe(100);
    });

    it('should return default tier for unknown role', () => {
      const tier = limiter.getTier('unknown');
      expect(tier).toBeDefined();
      expect(tier!.name).toBe('default');
    });
  });
});
