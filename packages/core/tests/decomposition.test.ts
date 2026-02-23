import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { SubTaskOrchestrator } from '../src/sub-task-orchestrator.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, DecompositionPlan } from '@joule/shared';

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

describe('Multi-Agent Decomposition', () => {
  let tools: ToolRegistry;
  let budget: BudgetManager;
  let tracer: TraceLogger;
  let providers: ModelProviderRegistry;
  let router: ModelRouter;
  let planner: Planner;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ result: `done: ${args.input ?? 'default'}` }),
    }, 'builtin');

    budget = new BudgetManager();
    tracer = new TraceLogger();
    providers = new ModelProviderRegistry();
  });

  function buildOrchestrator(responses: string[]) {
    providers.register(createMockProvider(responses) as any);
    router = new ModelRouter(providers, budget, defaultRouting);
    planner = new Planner(router, tools, providers, budget, tracer);
    return new SubTaskOrchestrator(planner, budget, router, tracer, tools, providers);
  }

  describe('shouldDecompose()', () => {
    it('should return false for simple tasks', () => {
      const orchestrator = buildOrchestrator([]);
      const task: Task = {
        id: generateId('task'),
        description: 'Simple task',
        createdAt: new Date().toISOString(),
      };
      expect(orchestrator.shouldDecompose(task, 0.5)).toBe(false);
    });

    it('should return false for short descriptions even with high complexity', () => {
      const orchestrator = buildOrchestrator([]);
      const task: Task = {
        id: generateId('task'),
        description: 'Short task but complex',
        createdAt: new Date().toISOString(),
      };
      expect(orchestrator.shouldDecompose(task, 0.9)).toBe(false);
    });

    it('should return true for long compound tasks with high complexity', () => {
      const orchestrator = buildOrchestrator([]);
      const task: Task = {
        id: generateId('task'),
        description: 'First, navigate to the website and log in with the credentials. And then, fill out the contact form with the provided information. After that, submit the form and verify the confirmation page. Next, take a screenshot of the result. Finally, send the screenshot via email to the team.',
        createdAt: new Date().toISOString(),
      };
      expect(orchestrator.shouldDecompose(task, 0.9)).toBe(true);
    });

    it('should return false when complexity is below threshold', () => {
      const orchestrator = buildOrchestrator([]);
      const task: Task = {
        id: generateId('task'),
        description: 'First, navigate to the website and log in with the credentials. And then, fill out the contact form with the provided information. After that, submit the form and verify the confirmation page. Next, take a screenshot of the result. Finally, send the screenshot via email to the team.',
        createdAt: new Date().toISOString(),
      };
      expect(orchestrator.shouldDecompose(task, 0.7)).toBe(false);
    });
  });

  describe('decompose()', () => {
    it('should decompose a task into sub-tasks via LLM', async () => {
      const orchestrator = buildOrchestrator([
        '{"subTasks": [{"description": "Log in", "dependsOn": [], "budgetShare": 0.3}, {"description": "Fill form", "dependsOn": [], "budgetShare": 0.7}], "strategy": "sequential", "aggregation": "combine results"}',
      ]);

      const task: Task = {
        id: generateId('task'),
        description: 'Log in and fill form',
        createdAt: new Date().toISOString(),
      };

      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);
      const spanId = tracer.startSpan(traceId, 'decompose-test');

      const plan = await orchestrator.decompose(task, envelope, traceId);

      tracer.endSpan(traceId, spanId);

      expect(plan.subTasks).toHaveLength(2);
      expect(plan.subTasks[0].description).toBe('Log in');
      expect(plan.subTasks[1].description).toBe('Fill form');
      expect(plan.strategy).toBe('sequential');
    });

    it('should return fallback plan on invalid LLM response', async () => {
      const orchestrator = buildOrchestrator([
        'This is not valid JSON!!!',
      ]);

      const task: Task = {
        id: generateId('task'),
        description: 'Test fallback',
        createdAt: new Date().toISOString(),
      };

      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);
      const spanId = tracer.startSpan(traceId, 'decompose-test');

      const plan = await orchestrator.decompose(task, envelope, traceId);

      tracer.endSpan(traceId, spanId);

      expect(plan.subTasks).toHaveLength(1);
      expect(plan.subTasks[0].description).toBe('Test fallback');
      expect(plan.subTasks[0].budgetShare).toBe(1.0);
    });
  });

  describe('aggregateResults()', () => {
    it('should combine multiple sub-task results', () => {
      const orchestrator = buildOrchestrator([]);

      const results = [
        { id: 'r1', taskId: 't1', traceId: 'tr1', status: 'completed' as const, result: 'Login succeeded', stepResults: [], budgetUsed: {} as any, trace: {} as any, completedAt: '' },
        { id: 'r2', taskId: 't2', traceId: 'tr2', status: 'completed' as const, result: 'Form submitted', stepResults: [], budgetUsed: {} as any, trace: {} as any, completedAt: '' },
      ];

      const aggregated = orchestrator.aggregateResults(results, 'combine');
      expect(aggregated).toContain('Login succeeded');
      expect(aggregated).toContain('Form submitted');
      expect(aggregated).toContain('[Sub-task 1]');
      expect(aggregated).toContain('[Sub-task 2]');
    });

    it('should handle single result without aggregation prefix', () => {
      const orchestrator = buildOrchestrator([]);

      const results = [
        { id: 'r1', taskId: 't1', traceId: 'tr1', status: 'completed' as const, result: 'Done', stepResults: [], budgetUsed: {} as any, trace: {} as any, completedAt: '' },
      ];

      const aggregated = orchestrator.aggregateResults(results, 'combine');
      expect(aggregated).toBe('Done');
    });

    it('should handle empty results', () => {
      const orchestrator = buildOrchestrator([]);
      const aggregated = orchestrator.aggregateResults([], 'combine');
      expect(aggregated).toBe('No sub-tasks executed.');
    });
  });

  describe('Budget splitting', () => {
    it('should create sub-envelope with correct share', () => {
      const parent = budget.createEnvelope('high');
      const parentUsage = budget.getUsage(parent);
      const originalTokens = parentUsage.tokensRemaining;

      const sub = budget.createSubEnvelope(parent, 0.5);
      const subUsage = budget.getUsage(sub);

      expect(subUsage.tokensRemaining).toBe(Math.floor(originalTokens * 0.5));
    });

    it('should mirror deductions to parent envelope', () => {
      const parent = budget.createEnvelope('high');
      const parentBefore = budget.getUsage(parent);

      const sub = budget.createSubEnvelope(parent, 0.5);
      budget.deductToolCall(sub);

      const parentAfter = budget.getUsage(parent);
      expect(parentAfter.toolCallsUsed).toBe(parentBefore.toolCallsUsed + 1);
    });

    it('should clamp share to [0, 1]', () => {
      const parent = budget.createEnvelope('high');
      const parentUsage = budget.getUsage(parent);

      const sub = budget.createSubEnvelope(parent, 1.5); // Should clamp to 1.0
      const subUsage = budget.getUsage(sub);

      expect(subUsage.tokensRemaining).toBe(parentUsage.tokensRemaining);
    });
  });
});
