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

// Mock provider that returns controllable JSON responses in sequence
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
      const content = responses[callIndex] ?? '{"complexity": 0.5}';
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

function createTestTask(budget?: string): Task {
  return {
    id: generateId('task'),
    description: 'Test task that needs replanning',
    budget: budget as any ?? 'high',
    createdAt: new Date().toISOString(),
  };
}

function registerTools(tools: ToolRegistry) {
  tools.register({
    name: 'failing_tool',
    description: 'A tool that fails',
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.any(),
    execute: async () => { throw new Error('Tool broke'); },
  }, 'builtin');

  tools.register({
    name: 'working_tool',
    description: 'A tool that works',
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.any(),
    execute: async () => ({ result: 'success' }),
  }, 'builtin');
}

const defaultRoutingConfig: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
};

describe('Agentic Re-planning', () => {
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

  describe('Planner.replan()', () => {
    it('generates a recovery plan when a step fails', async () => {
      // replan() makes exactly 1 chat() call — the recovery plan
      const mockProvider = createMockProvider([
        '{"steps": [{"description": "Try alternative path", "toolName": "file_read", "toolArgs": {"path": "/backup/test.txt"}}]}',
      ]);
      providers.register(mockProvider as any);

      const router = new ModelRouter(providers, budget, defaultRoutingConfig);
      const planner = new Planner(router, tools, providers, budget, tracer);

      const task = createTestTask();
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const failedStep = { index: 0, description: 'Read file', toolName: 'file_read', toolArgs: { path: '/test.txt' } };
      const completedSteps = [
        { stepIndex: 0, toolName: 'file_read', toolArgs: { path: '/test.txt' }, output: null, success: false as const, durationMs: 10, error: 'File not found' },
      ];

      const recoveryPlan = await planner.replan(task, failedStep, 'File not found', completedSteps, envelope, traceId);

      expect(recoveryPlan.steps.length).toBe(1);
      expect(recoveryPlan.steps[0].toolName).toBe('file_read');
      expect(recoveryPlan.complexity).toBe(0.9);
    });

    it('deducts an escalation when replanning', async () => {
      const mockProvider = createMockProvider([
        '{"steps": [{"description": "Recovery", "toolName": "file_read", "toolArgs": {"path": "/alt"}}]}',
      ]);
      providers.register(mockProvider as any);

      const router = new ModelRouter(providers, budget, defaultRoutingConfig);
      const planner = new Planner(router, tools, providers, budget, tracer);

      const task = createTestTask();
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      expect(envelope.state.escalationsUsed).toBe(0);

      const failedStep = { index: 0, description: 'Test', toolName: 'file_read', toolArgs: {} };
      await planner.replan(task, failedStep, 'Error', [], envelope, traceId);

      expect(envelope.state.escalationsUsed).toBe(1);
    });
  });

  describe('TaskExecutor re-planning loop', () => {
    it('triggers re-planning when a step fails and escalation budget is available', async () => {
      // Chat call order: 0=spec, 1=classify, 2=plan, 3=critique, 4=replan, 5=synthesize
      const mockProvider = createMockProvider([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Run broken tool", "toolName": "failing_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        '{"steps": [{"description": "Run working tool", "toolName": "working_tool", "toolArgs": {}}]}',
        'Recovery complete: the task was handled via an alternative approach.',
      ]);
      providers.register(mockProvider as any);
      registerTools(tools);

      const router = new ModelRouter(providers, budget, defaultRoutingConfig);
      const planner = new Planner(router, tools, providers, budget, tracer);
      const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRoutingConfig);

      const task = createTestTask();
      const result = await executor.execute(task);

      expect(result.stepResults.length).toBe(2);
      expect(result.stepResults[0].success).toBe(false);
      expect(result.stepResults[1].success).toBe(true);
      expect(result.status).toBe('completed');
    });

    it('does not replan when no escalation budget remains', async () => {
      // Chat call order: 0=spec, 1=classify, 2=plan, 3=critique, 4=synthesize
      const mockProvider = createMockProvider([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Run broken tool", "toolName": "failing_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        'Partial result with failure.',
      ]);
      providers.register(mockProvider as any);

      tools.register({
        name: 'failing_tool',
        description: 'A tool that fails',
        inputSchema: z.object({}).passthrough(),
        outputSchema: z.any(),
        execute: async () => { throw new Error('Tool broke'); },
      }, 'builtin');

      const router = new ModelRouter(providers, budget, defaultRoutingConfig);
      const planner = new Planner(router, tools, providers, budget, tracer);
      const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRoutingConfig);

      // 'low' budget has maxEscalations: 0
      const task = createTestTask('low');
      const result = await executor.execute(task);

      expect(result.stepResults.length).toBe(1);
      expect(result.stepResults[0].success).toBe(false);
      expect(result.status).toBe('completed');
    });

    it('enforces maxReplanDepth limit', async () => {
      // Chat call order: 0=spec, 1=classify, 2=plan (failing_tool), 3=critique, 4=replan (also failing_tool), 5=synthesize
      const mockProvider = createMockProvider([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Step 1", "toolName": "failing_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        '{"steps": [{"description": "Recovery 1", "toolName": "failing_tool", "toolArgs": {}}]}',
        'Done with partial failure.',
      ]);
      providers.register(mockProvider as any);

      tools.register({
        name: 'failing_tool',
        description: 'Always fails',
        inputSchema: z.object({}).passthrough(),
        outputSchema: z.any(),
        execute: async () => { throw new Error('Always fails'); },
      }, 'builtin');

      const routingConfig: RoutingConfig = {
        ...defaultRoutingConfig,
        maxReplanDepth: 1, // Only allow 1 level of re-planning
      };

      const router = new ModelRouter(providers, budget, routingConfig);
      const planner = new Planner(router, tools, providers, budget, tracer);
      const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, routingConfig);

      const task = createTestTask('high');
      const result = await executor.execute(task);

      // Step fails → replan (depth 0→1) → recovery also fails → no deeper replan (depth=1)
      expect(result.stepResults.length).toBe(2);
      expect(result.stepResults[0].success).toBe(false);
      expect(result.stepResults[1].success).toBe(false);
    });

    it('logs replan events in trace', async () => {
      // Chat call order: 0=spec, 1=classify, 2=plan, 3=critique, 4=replan, 5=synthesize
      const mockProvider = createMockProvider([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Fail step", "toolName": "failing_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        '{"steps": [{"description": "Success step", "toolName": "working_tool", "toolArgs": {}}]}',
        'Done.',
      ]);
      providers.register(mockProvider as any);
      registerTools(tools);

      const router = new ModelRouter(providers, budget, defaultRoutingConfig);
      const planner = new Planner(router, tools, providers, budget, tracer);
      const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRoutingConfig);

      const task = createTestTask();
      const result = await executor.execute(task);

      // Collect all events from all spans (including nested children)
      function collectEvents(spans: typeof result.trace!.spans): typeof result.trace!.spans[0]['events'] {
        const events: typeof result.trace!.spans[0]['events'] = [];
        for (const span of spans) {
          events.push(...span.events);
          events.push(...collectEvents(span.children));
        }
        return events;
      }

      const allEvents = collectEvents(result.trace!.spans);
      const escalationEvents = allEvents.filter(e => e.type === 'escalation');
      const replanEvents = allEvents.filter(e => e.type === 'replan');

      expect(escalationEvents.length).toBeGreaterThanOrEqual(1);
      expect(replanEvents.length).toBeGreaterThanOrEqual(1);
      expect(replanEvents[0].data.failedStep).toBe(0);
    });
  });
});
