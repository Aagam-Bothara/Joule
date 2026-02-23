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

function buildExecutor(responses: string[], tools: ToolRegistry) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  providers.register(createMockProvider(responses) as any);
  const router = new ModelRouter(providers, budget, defaultRouting);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRouting);
  return { executor, tracer };
}

function createTask(): Task {
  return {
    id: generateId('task'),
    description: 'Verification test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('Step Verification', () => {
  let tools: ToolRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'Returns result with input',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ result: `success: ${args.input ?? 'default'}` }),
    }, 'builtin');
  });

  it('should pass verification when output matches assertion (output_check)', async () => {
    const { executor, tracer } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      JSON.stringify({
        steps: [{
          description: 'Run tool',
          toolName: 'test_tool',
          toolArgs: { input: 'hello' },
          verify: { type: 'output_check', assertion: 'success', retryOnFail: false },
        }],
      }),
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());

    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].success).toBe(true);

    // Check for step_verification event
    function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
      const events: typeof result.trace.spans[0]['events'] = [];
      for (const span of spans) {
        events.push(...span.events);
        events.push(...collectEvents(span.children));
      }
      return events;
    }
    const allEvents = collectEvents(result.trace.spans);
    const verifyEvents = allEvents.filter(e => e.type === 'step_verification');
    expect(verifyEvents.length).toBe(1);
    expect(verifyEvents[0].data.passed).toBe(true);
  });

  it('should fail verification when output does not match assertion', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      JSON.stringify({
        steps: [{
          description: 'Run tool',
          toolName: 'test_tool',
          toolArgs: { input: 'hello' },
          verify: { type: 'output_check', assertion: 'NONEXISTENT_STRING', retryOnFail: false },
        }],
      }),
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());

    // Should still complete (verification failure doesn't block execution without retry)
    expect(result.status).toBe('completed');

    // Check for verification_failed event
    function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
      const events: typeof result.trace.spans[0]['events'] = [];
      for (const span of spans) {
        events.push(...span.events);
        events.push(...collectEvents(span.children));
      }
      return events;
    }
    const allEvents = collectEvents(result.trace.spans);
    const failEvents = allEvents.filter(e => e.type === 'verification_failed');
    expect(failEvents.length).toBe(1);
  });

  it('should retry step on verification failure when retryOnFail is true', async () => {
    let callCount = 0;
    tools.register({
      name: 'evolving_tool',
      description: 'Returns different results on each call',
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.any(),
      execute: async () => {
        callCount++;
        return { result: callCount >= 2 ? 'EXPECTED_VALUE' : 'wrong_value' };
      },
    }, 'builtin');

    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      JSON.stringify({
        steps: [{
          description: 'Run evolving tool',
          toolName: 'evolving_tool',
          toolArgs: {},
          verify: { type: 'output_check', assertion: 'EXPECTED_VALUE', retryOnFail: true, maxRetries: 2 },
        }],
      }),
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());
    expect(result.status).toBe('completed');
    // Should have both the original attempt and the retry
    expect(result.stepResults.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle regex assertions in output_check', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      JSON.stringify({
        steps: [{
          description: 'Run tool',
          toolName: 'test_tool',
          toolArgs: { input: 'test123' },
          verify: { type: 'output_check', assertion: 'success:\\s+test\\d+', retryOnFail: false },
        }],
      }),
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

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
    const verifyEvents = allEvents.filter(e => e.type === 'step_verification');
    expect(verifyEvents.length).toBe(1);
    expect(verifyEvents[0].data.passed).toBe(true);
  });

  it('should skip verification for steps with verify type "none"', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      JSON.stringify({
        steps: [{
          description: 'Run tool',
          toolName: 'test_tool',
          toolArgs: {},
          verify: { type: 'none', assertion: '' },
        }],
      }),
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());
    expect(result.status).toBe('completed');

    // No verification events should be logged for type "none"
    function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
      const events: typeof result.trace.spans[0]['events'] = [];
      for (const span of spans) {
        events.push(...span.events);
        events.push(...collectEvents(span.children));
      }
      return events;
    }
    const allEvents = collectEvents(result.trace.spans);
    const verifyEvents = allEvents.filter(e => e.type === 'step_verification');
    const failEvents = allEvents.filter(e => e.type === 'verification_failed');
    expect(verifyEvents.length).toBe(0);
    expect(failEvents.length).toBe(0);
  });

  it('should skip verification for steps without verify field', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

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
    const verifyEvents = allEvents.filter(e => e.type === 'step_verification');
    const failEvents = allEvents.filter(e => e.type === 'verification_failed');
    expect(verifyEvents.length).toBe(0);
    expect(failEvents.length).toBe(0);
  });
});
