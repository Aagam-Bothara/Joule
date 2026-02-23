import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner, type PlanStep } from '../src/planner.js';
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

describe('Hybrid Automation Strategy', () => {
  let tools: ToolRegistry;
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

    tools.register({
      name: 'browser_navigate',
      description: 'Navigate browser',
      inputSchema: z.object({ url: z.string() }).passthrough(),
      outputSchema: z.any(),
      execute: async () => ({ title: 'Page', url: 'https://example.com' }),
    }, 'builtin');

    tools.register({
      name: 'browser_click',
      description: 'Click element',
      inputSchema: z.object({ selector: z.string() }).passthrough(),
      outputSchema: z.any(),
      execute: async () => ({ success: true }),
    }, 'builtin');

    tools.register({
      name: 'http_fetch',
      description: 'Fetch URL',
      inputSchema: z.object({ url: z.string(), method: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async () => ({ status: 200, body: '{}' }),
    }, 'builtin');

    const budget = new BudgetManager();
    const tracer = new TraceLogger();
    const providers = new ModelProviderRegistry();
    providers.register(createMockProvider([]) as any);
    const router = new ModelRouter(providers, budget, defaultRouting);
    planner = new Planner(router, tools, providers, budget, tracer);
  });

  describe('selectAutomationStrategy()', () => {
    it('should select DOM strategy for standard browser tasks', () => {
      const task: Task = { id: 'test', description: 'Click the submit button', createdAt: '' };
      const step: PlanStep = { index: 0, description: 'Click', toolName: 'browser_click', toolArgs: { selector: '.btn' } };

      const strategy = planner.selectAutomationStrategy(task, step);
      expect(strategy.primary).toBe('dom');
      expect(strategy.fallbackChain).toContain('vision');
      expect(strategy.fallbackChain).toContain('api');
    });

    it('should select API strategy when task mentions API', () => {
      const task: Task = { id: 'test', description: 'Use the REST API to fetch user data', createdAt: '' };
      const step: PlanStep = { index: 0, description: 'Fetch', toolName: 'http_fetch', toolArgs: { url: 'https://api.example.com' } };

      const strategy = planner.selectAutomationStrategy(task, step);
      expect(strategy.primary).toBe('api');
      expect(strategy.reason).toContain('API');
    });

    it('should select vision strategy for visual tasks', () => {
      const task: Task = { id: 'test', description: 'Take a screenshot and look at the page layout', createdAt: '' };
      const step: PlanStep = { index: 0, description: 'Navigate', toolName: 'browser_navigate', toolArgs: { url: 'https://example.com' } };

      const strategy = planner.selectAutomationStrategy(task, step);
      expect(strategy.primary).toBe('vision');
      expect(strategy.reason).toContain('Visual');
    });

    it('should return default DOM with empty fallback for non-browser tasks', () => {
      const task: Task = { id: 'test', description: 'Run test tool', createdAt: '' };
      const step: PlanStep = { index: 0, description: 'Run', toolName: 'test_tool', toolArgs: {} };

      const strategy = planner.selectAutomationStrategy(task, step);
      expect(strategy.primary).toBe('dom');
      expect(strategy.fallbackChain).toHaveLength(0);
    });
  });

  describe('annotatePlanWithStrategies()', () => {
    it('should annotate browser steps with strategies', () => {
      const task: Task = { id: 'test', description: 'Browse and click', createdAt: '' };
      const plan = {
        taskId: 'test',
        complexity: 0.7,
        steps: [
          { index: 0, description: 'Navigate', toolName: 'browser_navigate', toolArgs: { url: 'https://example.com' } },
          { index: 1, description: 'Click', toolName: 'browser_click', toolArgs: { selector: '.btn' } },
          { index: 2, description: 'Run', toolName: 'test_tool', toolArgs: {} },
        ],
      };

      planner.annotatePlanWithStrategies(task, plan);

      expect(plan.steps[0].strategy).toBeDefined();
      expect(plan.steps[0].strategy!.primary).toBe('dom');
      expect(plan.steps[1].strategy).toBeDefined();
      expect(plan.steps[1].strategy!.primary).toBe('dom');
      // Non-browser tool should NOT get a strategy
      expect(plan.steps[2].strategy).toBeUndefined();
    });
  });

  describe('Strategy fallback in execution', () => {
    it('should log strategy_selected trace event when browser step fails with strategy', async () => {
      // Register a failing browser tool
      tools.register({
        name: 'browser_click_fail',
        description: 'Click element (always fails)',
        inputSchema: z.object({ selector: z.string() }).passthrough(),
        outputSchema: z.any(),
        execute: async () => { throw new Error('Element not found'); },
      }, 'builtin');

      // Register os tools for vision fallback
      tools.register({
        name: 'os_screenshot',
        description: 'Take screenshot',
        inputSchema: z.object({}).passthrough(),
        outputSchema: z.any(),
        execute: async () => ({ filePath: '/tmp/screenshot.png' }),
      }, 'builtin');

      tools.register({
        name: 'os_mouse',
        description: 'Mouse action',
        inputSchema: z.object({ action: z.string(), x: z.number(), y: z.number(), button: z.string().optional() }).passthrough(),
        outputSchema: z.any(),
        execute: async () => ({ success: true }),
      }, 'builtin');

      const budget = new BudgetManager();
      const tracer = new TraceLogger();
      const providers = new ModelProviderRegistry();
      providers.register(createMockProvider([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.7}',
        '{"steps": [{"description": "Click button", "toolName": "browser_click_fail", "toolArgs": {"selector": ".btn"}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        'Done.',
      ]) as any);
      const router = new ModelRouter(providers, budget, defaultRouting);
      const testPlanner = new Planner(router, tools, providers, budget, tracer);
      const executor = new TaskExecutor(budget, router, tracer, tools, testPlanner, providers, undefined, defaultRouting);

      const task: Task = {
        id: generateId('task'),
        description: 'Click a button on the page',
        budget: 'high' as any,
        createdAt: new Date().toISOString(),
      };

      const result = await executor.execute(task);

      function collectEvents(spans: typeof result.trace.spans): typeof result.trace.spans[0]['events'] {
        const events: typeof result.trace.spans[0]['events'] = [];
        for (const span of spans) {
          events.push(...span.events);
          events.push(...collectEvents(span.children));
        }
        return events;
      }

      const allEvents = collectEvents(result.trace.spans);
      const strategyEvents = allEvents.filter(e => e.type === 'strategy_selected');

      // Strategy should be triggered because browser_click_fail has a strategy annotation
      // and the step failed — vision fallback steps were injected
      expect(strategyEvents.length).toBeGreaterThanOrEqual(1);
      if (strategyEvents.length > 0) {
        expect(strategyEvents[0].data.original).toBe('dom');
        expect(strategyEvents[0].data.fallback).toBe('vision');
      }
    });
  });
});
