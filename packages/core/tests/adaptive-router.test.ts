import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdaptiveRouter, type PerformanceReport } from '../src/adaptive-router.js';

function createMockRouter() {
  return {
    route: vi.fn(async (purpose: any, envelope: any, context: any) => ({
      tier: 'slm',
      provider: 'ollama',
      model: 'llama3.2:3b',
      reason: 'purpose=classify, tier=slm',
      estimatedCost: 0.001,
      estimatedEnergyWh: 0.0001,
    })),
    reportFailure: vi.fn(),
    reportSuccess: vi.fn(),
  };
}

function createMockMemory() {
  const facts: any[] = [];
  return {
    storeFact: vi.fn(async (key: string, value: unknown, category: string, source: string) => {
      const fact = { id: `f-${facts.length}`, key, value, category, source, confidence: 0.5, tags: [] };
      facts.push(fact);
      return fact;
    }),
    searchFacts: vi.fn(async (query: any) => {
      return facts.filter(f => !query.category || f.category === query.category);
    }),
  };
}

describe('AdaptiveRouter', () => {
  let mockRouter: ReturnType<typeof createMockRouter>;
  let mockMemory: ReturnType<typeof createMockMemory>;
  let adaptive: AdaptiveRouter;

  beforeEach(() => {
    mockRouter = createMockRouter();
    mockMemory = createMockMemory();
    adaptive = new AdaptiveRouter(mockRouter as any, mockMemory as any);
  });

  describe('route', () => {
    it('should delegate to base router when no task type', async () => {
      const result = await adaptive.route('classify', {});
      expect(mockRouter.route).toHaveBeenCalledOnce();
      expect(result.model).toBe('llama3.2:3b');
    });

    it('should use base router when no performance data', async () => {
      const result = await adaptive.route('execute', {}, { taskType: 'code-review' });
      expect(result.model).toBe('llama3.2:3b');
    });
  });

  describe('reportPerformance', () => {
    it('should track model performance', () => {
      const report: PerformanceReport = {
        taskType: 'code-review',
        outcome: 'success',
        model: 'llama3.2:3b',
        provider: 'ollama' as any,
        latencyMs: 2000,
        costUsd: 0.001,
        qualityScore: 0.9,
      };

      adaptive.reportPerformance(report);

      // Should persist to memory
      expect(mockMemory.storeFact).toHaveBeenCalledWith(
        'adaptive-routing:ollama:llama3.2:3b:code-review',
        expect.objectContaining({
          model: 'llama3.2:3b',
          provider: 'ollama',
          successes: 1,
          failures: 0,
        }),
        'adaptive-routing',
        'adaptive-router',
      );
    });

    it('should accumulate stats across multiple reports', () => {
      adaptive.reportPerformance({
        taskType: 'debug', outcome: 'success', model: 'gpt-4o',
        provider: 'openai' as any, latencyMs: 3000, costUsd: 0.05,
      });
      adaptive.reportPerformance({
        taskType: 'debug', outcome: 'failed', model: 'gpt-4o',
        provider: 'openai' as any, latencyMs: 5000, costUsd: 0.08,
      });

      // Two storeFact calls (one per report)
      expect(mockMemory.storeFact).toHaveBeenCalledTimes(2);

      // Second call should have accumulated stats
      const lastCall = mockMemory.storeFact.mock.calls[1];
      const record = lastCall[1] as any;
      expect(record.successes).toBe(1);
      expect(record.failures).toBe(1);
      expect(record.totalCostUsd).toBeCloseTo(0.13);
    });
  });

  describe('getStats', () => {
    it('should return empty stats when no data', async () => {
      const stats = await adaptive.getStats();
      expect(stats.totalRecords).toBe(0);
      expect(stats.modelStats).toHaveLength(0);
    });

    it('should aggregate stats by model', async () => {
      adaptive.reportPerformance({
        taskType: 'review', outcome: 'success', model: 'llama3.2:3b',
        provider: 'ollama' as any, latencyMs: 1000, costUsd: 0.001,
      });
      adaptive.reportPerformance({
        taskType: 'debug', outcome: 'success', model: 'llama3.2:3b',
        provider: 'ollama' as any, latencyMs: 2000, costUsd: 0.002,
      });
      adaptive.reportPerformance({
        taskType: 'review', outcome: 'failed', model: 'gpt-4o',
        provider: 'openai' as any, latencyMs: 3000, costUsd: 0.05,
      });

      const stats = await adaptive.getStats();
      expect(stats.totalRecords).toBe(3);
      expect(stats.modelStats).toHaveLength(2);

      const ollamaStats = stats.modelStats.find(s => s.model === 'llama3.2:3b');
      expect(ollamaStats).toBeDefined();
      expect(ollamaStats!.overallSuccessRate).toBe(1.0);
      expect(ollamaStats!.taskTypes).toContain('review');
      expect(ollamaStats!.taskTypes).toContain('debug');
    });
  });

  describe('failover delegation', () => {
    it('should delegate reportFailure to base router', () => {
      adaptive.reportFailure('ollama' as any);
      expect(mockRouter.reportFailure).toHaveBeenCalledWith('ollama');
    });

    it('should delegate reportSuccess to base router', () => {
      adaptive.reportSuccess('openai' as any);
      expect(mockRouter.reportSuccess).toHaveBeenCalledWith('openai');
    });
  });
});
