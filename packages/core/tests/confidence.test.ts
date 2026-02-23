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
import type { Task, RoutingConfig } from '@joule/shared';

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
    description: 'Confidence scoring test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('Confidence Scoring Per Step', () => {
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

  it('should populate confidence on StepResult from critique scores', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "hello"}}]}',
      '{"overall": 0.9, "stepConfidences": [0.85], "issues": []}',
      'Done.',
    ]);

    const result = await executor.execute(createTask());

    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].confidence).toBeDefined();
    expect(result.stepResults[0].confidence).toBe(0.85);
  });

  it('should log confidence_update trace events', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Step 1", "toolName": "test_tool", "toolArgs": {}}, {"description": "Step 2", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.9, 0.7], "issues": []}',
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
    const confEvents = allEvents.filter(e => e.type === 'confidence_update');
    expect(confEvents).toHaveLength(2);
    expect(confEvents[0].data.stepIndex).toBe(0);
    expect(confEvents[0].data.confidence).toBe(0.9);
    expect(confEvents[1].data.stepIndex).toBe(1);
  });

  it('should default to 0.7 confidence when critique returns no stepConfidences', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "issues": []}',  // No stepConfidences
      'Done.',
    ]);

    const result = await executor.execute(createTask());

    expect(result.stepResults[0].confidence).toBe(0.7);
  });

  it('should adjust confidence down after step failures', async () => {
    tools.register({
      name: 'failing_tool',
      description: 'A tool that fails',
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.any(),
      execute: async () => { throw new Error('Tool broke'); },
    }, 'builtin');

    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Fail", "toolName": "failing_tool", "toolArgs": {}}, {"description": "OK", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8, 0.8], "issues": []}',
      'Done.',
    ]);

    const result = await executor.execute(createTask());

    // Second step's confidence should be reduced due to prior failure
    const step2 = result.stepResults.find(s => s.toolName === 'test_tool');
    expect(step2).toBeDefined();
    expect(step2!.confidence).toBeLessThan(0.8);
  });
});
