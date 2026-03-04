import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LongTermMemory, type TaskOutcome } from '../src/long-term-memory.js';

// Mock AgentMemory
function createMockMemory() {
  const episodes: any[] = [];
  const facts: any[] = [];

  return {
    recordEpisode: vi.fn(async (taskId, summary, outcome, tools, energy, carbon, tags) => {
      const ep = { id: `ep-${episodes.length}`, taskId, summary, outcome, toolsUsed: tools, energyUsed: energy, carbonUsed: carbon, tags, timestamp: new Date().toISOString() };
      episodes.push(ep);
      return ep;
    }),
    searchEpisodes: vi.fn(async (tags: string[]) => {
      return episodes.filter(e => tags.some(t => e.tags.includes(t)));
    }),
    getRecentEpisodes: vi.fn(async (limit: number) => {
      return episodes.slice(-limit);
    }),
    storeFact: vi.fn(async (key, value, category, source) => {
      const fact = { id: `fact-${facts.length}`, key, value, category, source, confidence: 0.5, tags: [] };
      facts.push(fact);
      return fact;
    }),
    searchFacts: vi.fn(async (query: any) => {
      return facts.filter(f => !query.category || f.category === query.category);
    }),
    _episodes: episodes,
    _facts: facts,
  };
}

describe('LongTermMemory', () => {
  let memory: ReturnType<typeof createMockMemory>;
  let ltm: LongTermMemory;

  beforeEach(() => {
    memory = createMockMemory();
    ltm = new LongTermMemory(memory as any);
  });

  describe('recordOutcome', () => {
    it('should record a successful task outcome', async () => {
      const outcome: TaskOutcome = {
        taskId: 'task-1',
        taskType: 'code-review',
        description: 'Reviewed auth module',
        outcome: 'success',
        toolsUsed: ['file_read', 'grep_search'],
        durationMs: 5000,
        costUsd: 0.01,
        energyUsed: 0.001,
        stepsCompleted: 3,
        totalSteps: 3,
      };

      await ltm.recordOutcome(outcome);

      expect(memory.recordEpisode).toHaveBeenCalledOnce();
      expect(memory.recordEpisode).toHaveBeenCalledWith(
        'task-1', 'Reviewed auth module', 'success',
        ['file_read', 'grep_search'], 0.001, 0, // carbonUsed defaults to 0
        ['code-review', 'file_read', 'grep_search'],
      );
    });

    it('should store failure patterns', async () => {
      const outcome: TaskOutcome = {
        taskId: 'task-2',
        taskType: 'bug-fix',
        description: 'Fix login crash',
        outcome: 'failed',
        toolsUsed: ['shell_exec'],
        durationMs: 3000,
        costUsd: 0.005,
        energyUsed: 0.001,
        stepsCompleted: 1,
        totalSteps: 3,
        errorMessage: 'Command timeout after 30000ms',
      };

      await ltm.recordOutcome(outcome);

      // Should store failure pattern as a fact
      expect(memory.storeFact).toHaveBeenCalledWith(
        expect.stringContaining('failure:bug-fix:'),
        expect.objectContaining({
          error: 'Command timeout after 30000ms',
          tools: ['shell_exec'],
          taskType: 'bug-fix',
        }),
        'failure-patterns',
        'task:task-2',
      );
    });

    it('should store lessons learned', async () => {
      const outcome: TaskOutcome = {
        taskId: 'task-3',
        taskType: 'research',
        description: 'Research API options',
        outcome: 'success',
        toolsUsed: ['web_search'],
        durationMs: 10000,
        costUsd: 0.02,
        energyUsed: 0.002,
        stepsCompleted: 5,
        totalSteps: 5,
        lessonsLearned: 'Always check rate limits before making multiple API calls',
      };

      await ltm.recordOutcome(outcome);

      expect(memory.storeFact).toHaveBeenCalledWith(
        'lesson:research:task-3',
        'Always check rate limits before making multiple API calls',
        'lessons',
        'task:task-3',
      );
    });
  });

  describe('getRecommendations', () => {
    it('should return recommendations based on past outcomes', async () => {
      // Record some outcomes first
      await ltm.recordOutcome({
        taskId: 't1', taskType: 'code-review', description: 'Review 1', outcome: 'success',
        toolsUsed: ['file_read', 'grep_search'], durationMs: 5000, costUsd: 0.01,
        energyUsed: 0.001, stepsCompleted: 3, totalSteps: 3,
      });
      await ltm.recordOutcome({
        taskId: 't2', taskType: 'code-review', description: 'Review 2', outcome: 'success',
        toolsUsed: ['file_read', 'grep_search'], durationMs: 4000, costUsd: 0.01,
        energyUsed: 0.001, stepsCompleted: 2, totalSteps: 2,
      });
      await ltm.recordOutcome({
        taskId: 't3', taskType: 'code-review', description: 'Review 3', outcome: 'success',
        toolsUsed: ['file_read'], durationMs: 3000, costUsd: 0.005,
        energyUsed: 0.001, stepsCompleted: 1, totalSteps: 1,
      });

      const rec = await ltm.getRecommendations('code-review', 'Review new PR');

      expect(rec.estimatedSuccessRate).toBe(1.0);
      expect(rec.suggestedTools).toContain('file_read');
    });

    it('should warn about unreliable tools', async () => {
      // Record failures with a specific tool
      for (let i = 0; i < 4; i++) {
        await ltm.recordOutcome({
          taskId: `t${i}`, taskType: 'deploy', description: `Deploy ${i}`, outcome: 'failed',
          toolsUsed: ['shell_exec'], durationMs: 5000, costUsd: 0.01,
          energyUsed: 0.001, stepsCompleted: 0, totalSteps: 1,
          errorMessage: 'Deployment failed',
        });
      }

      const rec = await ltm.getRecommendations('deploy', 'Deploy to prod');

      expect(rec.avoidTools).toContain('shell_exec');
      expect(rec.estimatedSuccessRate).toBe(0);
    });
  });

  describe('getToolEffectiveness', () => {
    it('should track tool success rates', async () => {
      await ltm.recordOutcome({
        taskId: 't1', taskType: 'search', description: 'Search 1', outcome: 'success',
        toolsUsed: ['grep_search'], durationMs: 1000, costUsd: 0.001,
        energyUsed: 0.0001, stepsCompleted: 1, totalSteps: 1,
      });
      await ltm.recordOutcome({
        taskId: 't2', taskType: 'search', description: 'Search 2', outcome: 'failed',
        toolsUsed: ['grep_search'], durationMs: 2000, costUsd: 0.001,
        energyUsed: 0.0001, stepsCompleted: 0, totalSteps: 1,
      });

      const effectiveness = await ltm.getToolEffectiveness();
      const grepTool = effectiveness.find(t => t.toolName === 'grep_search');

      expect(grepTool).toBeDefined();
      expect(grepTool!.totalUses).toBe(2);
      expect(grepTool!.successRate).toBe(0.5);
      expect(grepTool!.taskTypes).toContain('search');
    });
  });

  describe('getStats', () => {
    it('should return overall learning statistics', async () => {
      await ltm.recordOutcome({
        taskId: 't1', taskType: 'code-review', description: 'R1', outcome: 'success',
        toolsUsed: ['file_read'], durationMs: 3000, costUsd: 0.01,
        energyUsed: 0.001, stepsCompleted: 1, totalSteps: 1,
      });

      const stats = await ltm.getStats();

      expect(stats.totalOutcomes).toBe(1);
      expect(stats.successRate).toBe(1.0);
      expect(stats.taskTypeStats).toHaveLength(1);
      expect(stats.taskTypeStats[0].type).toBe('code-review');
    });
  });

  describe('buildContextForTask', () => {
    it('should build a context string from past experience', async () => {
      await ltm.recordOutcome({
        taskId: 't1', taskType: 'debug', description: 'Fixed memory leak', outcome: 'success',
        toolsUsed: ['file_read', 'shell_exec'], durationMs: 5000, costUsd: 0.01,
        energyUsed: 0.001, stepsCompleted: 3, totalSteps: 3,
        lessonsLearned: 'Check heap snapshots first',
      });

      const context = await ltm.buildContextForTask('debug', 'Fix performance issue');

      expect(typeof context).toBe('string');
    });
  });
});
