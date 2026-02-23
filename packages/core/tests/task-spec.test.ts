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

describe('TaskSpec (Planner.specifyTask)', () => {
  let budget: BudgetManager;
  let tracer: TraceLogger;
  let tools: ToolRegistry;
  let providers: ModelProviderRegistry;

  beforeEach(() => {
    budget = new BudgetManager();
    tracer = new TraceLogger();
    tools = new ToolRegistry();
    providers = new ModelProviderRegistry();
  });

  it('should generate a valid TaskSpec from model response', async () => {
    const mockProvider = createMockProvider([
      JSON.stringify({
        goal: 'Search for weather on Google',
        constraints: ['Use HTTPS'],
        successCriteria: [
          { description: 'Page shows weather results', type: 'page_state', check: { titleContains: 'weather' } },
        ],
      }),
    ]);
    providers.register(mockProvider as any);

    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);

    const task: Task = {
      id: generateId('task'),
      description: 'Search for weather on Google',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const spec = await planner.specifyTask(task, envelope, traceId);

    expect(spec.goal).toBe('Search for weather on Google');
    expect(spec.constraints).toContain('Use HTTPS');
    expect(spec.successCriteria).toHaveLength(1);
    expect(spec.successCriteria[0].type).toBe('page_state');
    expect(spec.successCriteria[0].check).toHaveProperty('titleContains', 'weather');
  });

  it('should return fallback spec when model response is invalid JSON', async () => {
    const mockProvider = createMockProvider([
      'This is not valid JSON at all',
    ]);
    providers.register(mockProvider as any);

    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);

    const task: Task = {
      id: generateId('task'),
      description: 'Play a song on YouTube',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const spec = await planner.specifyTask(task, envelope, traceId);

    // Fallback: goal = task description, 1 default criterion
    expect(spec.goal).toBe('Play a song on YouTube');
    expect(spec.constraints).toEqual([]);
    expect(spec.successCriteria).toHaveLength(1);
    expect(spec.successCriteria[0].type).toBe('tool_succeeded');
  });

  it('should add a default criterion if response has empty successCriteria', async () => {
    const mockProvider = createMockProvider([
      '{"goal": "test goal", "constraints": [], "successCriteria": []}',
    ]);
    providers.register(mockProvider as any);

    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);

    const task: Task = {
      id: generateId('task'),
      description: 'Simple test',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const spec = await planner.specifyTask(task, envelope, traceId);

    expect(spec.goal).toBe('test goal');
    expect(spec.successCriteria).toHaveLength(1);
    expect(spec.successCriteria[0].description).toBe('Task completed successfully');
  });

  it('should handle multiple success criteria types', async () => {
    const mockProvider = createMockProvider([
      JSON.stringify({
        goal: 'Write hello.txt and verify it',
        constraints: ['no binary files'],
        successCriteria: [
          { description: 'File created', type: 'file_exists', check: { path: '/tmp/hello.txt' } },
          { description: 'Content written', type: 'output_contains', check: { pattern: 'hello' } },
          { description: 'Tool ran', type: 'tool_succeeded', check: { toolName: 'file_write' } },
        ],
      }),
    ]);
    providers.register(mockProvider as any);

    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);

    const task: Task = {
      id: generateId('task'),
      description: 'Write hello.txt',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const spec = await planner.specifyTask(task, envelope, traceId);

    expect(spec.successCriteria).toHaveLength(3);
    expect(spec.successCriteria[0].type).toBe('file_exists');
    expect(spec.successCriteria[1].type).toBe('output_contains');
    expect(spec.successCriteria[2].type).toBe('tool_succeeded');
  });
});

describe('Criteria Evaluation (via TaskResult)', () => {
  let tools: ToolRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ result: `processed: ${args.input ?? 'default'}` }),
    }, 'builtin');
  });

  function buildExecutor(responses: string[]) {
    const budget = new BudgetManager();
    const tracer = new TraceLogger();
    const providers = new ModelProviderRegistry();
    providers.register(createMockProvider(responses) as any);
    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);
    return new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRouting);
  }

  it('should evaluate output_contains criterion', async () => {
    const executor = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": [{"description": "output has processed", "type": "output_contains", "check": {"pattern": "processed"}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "data"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'The tool processed data successfully.',
    ]);

    const task: Task = {
      id: generateId('task'),
      description: 'Run test',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const result = await executor.execute(task);

    expect(result.criteriaResults).toBeDefined();
    expect(result.criteriaResults!).toHaveLength(1);
    expect(result.criteriaResults![0].met).toBe(true);
    expect(result.criteriaResults![0].evidence).toContain('processed');
  });

  it('should evaluate tool_succeeded criterion', async () => {
    const executor = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": [{"description": "test_tool ran", "type": "tool_succeeded", "check": {"toolName": "test_tool"}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ]);

    const task: Task = {
      id: generateId('task'),
      description: 'Run test',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const result = await executor.execute(task);

    expect(result.criteriaResults!).toHaveLength(1);
    expect(result.criteriaResults![0].met).toBe(true);
  });

  it('should report unmet criterion when output does not match', async () => {
    const executor = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": [{"description": "output has XYZ", "type": "output_contains", "check": {"pattern": "NONEXISTENT_PATTERN"}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'The tool ran fine but no special output.',
    ]);

    const task: Task = {
      id: generateId('task'),
      description: 'Run test',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const result = await executor.execute(task);

    expect(result.criteriaResults!).toHaveLength(1);
    expect(result.criteriaResults![0].met).toBe(false);
    expect(result.criteriaResults![0].evidence).toContain('does not match');
  });

  it('should evaluate custom criterion optimistically', async () => {
    const executor = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": [{"description": "custom check", "type": "custom", "check": {"assertion": "everything ok"}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ]);

    const task: Task = {
      id: generateId('task'),
      description: 'Run test',
      budget: 'high' as any,
      createdAt: new Date().toISOString(),
    };

    const result = await executor.execute(task);

    // Custom is optimistic — if any step succeeded, it's met
    expect(result.criteriaResults!).toHaveLength(1);
    expect(result.criteriaResults![0].met).toBe(true);
  });
});
