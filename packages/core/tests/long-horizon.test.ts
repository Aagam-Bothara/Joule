import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, StepResult } from '@joule/shared';

function createMockProvider(responses: string[]) {
  let callIndex = 0;
  return {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([
      { id: 'test-slm', name: 'Test SLM', tier: ModelTier.SLM, provider: 'ollama' },
      { id: 'test-llm', name: 'Test LLM', tier: ModelTier.LLM, provider: 'ollama' },
    ]),
    estimateCost: vi.fn().mockReturnValue(0.001),
    chat: vi.fn().mockImplementation(async () => {
      const content = responses[callIndex] ?? '{}';
      callIndex++;
      return {
        model: 'test-slm',
        provider: 'ollama',
        tier: ModelTier.SLM,
        content,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        latencyMs: 50,
        costUsd: 0.001,
        finishReason: 'stop',
      };
    }),
    chatStream: vi.fn(),
  };
}

const defaultRouting: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
};

function createTask(): Task {
  return {
    id: generateId('task'),
    description: 'Long horizon test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('Long-Horizon Stability', () => {
  let tools: ToolRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ result: `done: ${args.input ?? 'default'}` }),
    }, 'builtin');
  });

  function buildExecutor(responses: string[]) {
    const budget = new BudgetManager();
    const tracer = new TraceLogger();
    const providers = new ModelProviderRegistry();
    providers.register(createMockProvider(responses) as any);
    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);
    const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRouting);
    return { executor, tracer };
  }

  describe('compressStepHistory()', () => {
    it('should return full history for short step lists', () => {
      const { executor } = buildExecutor([]);
      const steps: StepResult[] = [
        { stepIndex: 0, toolName: 'tool_a', toolArgs: {}, output: 'ok', success: true, durationMs: 10 },
        { stepIndex: 1, toolName: 'tool_b', toolArgs: {}, output: 'ok', success: true, durationMs: 10 },
        { stepIndex: 2, toolName: 'tool_c', toolArgs: {}, output: 'ok', success: false, durationMs: 10, error: 'err' },
      ];

      const compressed = executor.compressStepHistory(steps, 5);
      expect(compressed).toContain('tool_a');
      expect(compressed).toContain('tool_b');
      expect(compressed).toContain('tool_c');
      // No compression marker
      expect(compressed).not.toContain('...');
    });

    it('should compress middle steps for long step lists', () => {
      const { executor } = buildExecutor([]);
      const steps: StepResult[] = Array.from({ length: 10 }, (_, i) => ({
        stepIndex: i,
        toolName: `tool_${i}`,
        toolArgs: {},
        output: `result_${i}`,
        success: i !== 5, // Step 5 fails
        durationMs: 10,
        error: i === 5 ? 'failed' : undefined,
      }));

      const compressed = executor.compressStepHistory(steps, 5);

      // Should contain first 2 steps
      expect(compressed).toContain('tool_0');
      expect(compressed).toContain('tool_1');

      // Should contain last 3 steps
      expect(compressed).toContain('tool_7');
      expect(compressed).toContain('tool_8');
      expect(compressed).toContain('tool_9');

      // Should have compression summary
      expect(compressed).toContain('... 5 steps');
      expect(compressed).toContain('succeeded');
      expect(compressed).toContain('failed');
    });
  });

  describe('Goal Checkpoint', () => {
    it('should log goal_checkpoint event during long execution', async () => {
      // Create a plan with 6 steps (checkpoint interval = max(3, ceil(6/3)) = 3)
      const sixSteps = Array.from({ length: 6 }, (_, i) =>
        `{"description": "Step ${i}", "toolName": "test_tool", "toolArgs": {"input": "${i}"}}`
      ).join(',');

      const { executor } = buildExecutor([
        '{"goal": "Complete all steps", "constraints": [], "successCriteria": [{"description": "all done", "type": "tool_succeeded", "check": {}}]}',
        '{"complexity": 0.3}',
        `{"steps": [${sixSteps}]}`,
        '{"overall": 0.8, "stepConfidences": [0.8, 0.8, 0.8, 0.8, 0.8, 0.8], "issues": []}',
        '{"onTrack": true, "drift": []}',  // Checkpoint after step 3
        'All steps done.',
      ]);

      const result = await executor.execute(createTask());
      expect(result.status).toBe('completed');

      function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
        const events: typeof result.trace.spans[0]['events'] = [];
        for (const span of spans) {
          events.push(...span.events);
          events.push(...collectEvents(span.children));
        }
        return events;
      }

      const allEvents = collectEvents(result.trace.spans);
      const checkpointEvents = allEvents.filter(e => e.type === 'goal_checkpoint');

      // Should have at least 1 checkpoint
      expect(checkpointEvents.length).toBeGreaterThanOrEqual(1);
      expect(checkpointEvents[0].data.onTrack).toBe(true);
    });

    it('should include checkpoint state transition for long plans', async () => {
      const sixSteps = Array.from({ length: 6 }, (_, i) =>
        `{"description": "Step ${i}", "toolName": "test_tool", "toolArgs": {"input": "${i}"}}`
      ).join(',');

      const { executor } = buildExecutor([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        `{"steps": [${sixSteps}]}`,
        '{"overall": 0.8, "stepConfidences": [0.8, 0.8, 0.8, 0.8, 0.8, 0.8], "issues": []}',
        '{"onTrack": true, "drift": []}',
        'Done.',
      ]);

      const result = await executor.execute(createTask());

      function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
        const events: typeof result.trace.spans[0]['events'] = [];
        for (const span of spans) {
          events.push(...span.events);
          events.push(...collectEvents(span.children));
        }
        return events;
      }

      const allEvents = collectEvents(result.trace.spans);
      const transitions = allEvents
        .filter(e => e.type === 'state_transition')
        .map(e => e.data.to);

      expect(transitions).toContain('checkpoint');
    });

    it('should not checkpoint on short plans (3 or fewer steps)', async () => {
      const { executor } = buildExecutor([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "S1", "toolName": "test_tool", "toolArgs": {}}, {"description": "S2", "toolName": "test_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8, 0.8], "issues": []}',
        'Done.',
      ]);

      const result = await executor.execute(createTask());

      function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
        const events: typeof result.trace.spans[0]['events'] = [];
        for (const span of spans) {
          events.push(...span.events);
          events.push(...collectEvents(span.children));
        }
        return events;
      }

      const allEvents = collectEvents(result.trace.spans);
      const checkpointEvents = allEvents.filter(e => e.type === 'goal_checkpoint');
      expect(checkpointEvents).toHaveLength(0);
    });
  });
});
