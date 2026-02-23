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
    description: 'Plan critique test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('Plan Critique (Meta-Reasoning)', () => {
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
    return { executor, planner, budget, tracer, providers, router };
  }

  it('should return a valid PlanScore from critiquePlan()', async () => {
    const { planner, budget, tracer, providers } = buildExecutor([
      '{"overall": 0.9, "stepConfidences": [0.95], "issues": []}',
    ]);

    const task = createTask();
    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const plan = {
      taskId: task.id,
      complexity: 0.5,
      steps: [{ index: 0, description: 'Run tool', toolName: 'test_tool', toolArgs: {} }],
    };

    const score = await planner.critiquePlan(task, plan, undefined, envelope, traceId);

    expect(score.overall).toBe(0.9);
    expect(score.stepConfidences).toHaveLength(1);
    expect(score.stepConfidences[0]).toBe(0.95);
    expect(score.issues).toEqual([]);
  });

  it('should return fallback score when critique response is invalid JSON', async () => {
    const { planner, budget, tracer } = buildExecutor([
      'This is not valid JSON!!',
    ]);

    const task = createTask();
    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const plan = {
      taskId: task.id,
      complexity: 0.5,
      steps: [
        { index: 0, description: 'Step 1', toolName: 'test_tool', toolArgs: {} },
        { index: 1, description: 'Step 2', toolName: 'test_tool', toolArgs: {} },
      ],
    };

    const score = await planner.critiquePlan(task, plan, undefined, envelope, traceId);

    expect(score.overall).toBe(0.7);
    expect(score.stepConfidences).toHaveLength(2);
    expect(score.stepConfidences[0]).toBe(0.7);
    expect(score.issues).toEqual([]);
  });

  it('should include critique state in state machine transitions', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.85, "stepConfidences": [0.9], "issues": []}',
      'Done.',
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
    const transitions = allEvents
      .filter(e => e.type === 'state_transition')
      .map(e => e.data.to);

    expect(transitions).toContain('critique');
  });

  it('should log plan_critique trace event', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.75, "stepConfidences": [0.8], "issues": ["Missing error handling"]}',
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
    const critiqueEvents = allEvents.filter(e => e.type === 'plan_critique');
    expect(critiqueEvents).toHaveLength(1);
    expect(critiqueEvents[0].data.overall).toBe(0.75);
    expect(critiqueEvents[0].data.issueCount).toBe(1);
  });

  it('should clamp overall score between 0 and 1', async () => {
    const { planner, budget, tracer } = buildExecutor([
      '{"overall": 1.5, "stepConfidences": [-0.5, 2.0], "issues": []}',
    ]);

    const task = createTask();
    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const plan = {
      taskId: task.id,
      complexity: 0.5,
      steps: [
        { index: 0, description: 'Step 1', toolName: 'test_tool', toolArgs: {} },
        { index: 1, description: 'Step 2', toolName: 'test_tool', toolArgs: {} },
      ],
    };

    const score = await planner.critiquePlan(task, plan, undefined, envelope, traceId);

    expect(score.overall).toBe(1.0);
    expect(score.stepConfidences[0]).toBe(0);
    expect(score.stepConfidences[1]).toBe(1.0);
  });
});
