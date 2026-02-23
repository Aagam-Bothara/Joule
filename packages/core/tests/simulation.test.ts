import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { ExecutionSimulator } from '../src/execution-simulator.js';
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
    description: 'Simulation test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('Execution Simulation', () => {
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
  });

  describe('ExecutionSimulator standalone', () => {
    it('should pass valid plans with no issues', () => {
      const simulator = new ExecutionSimulator(tools);
      const result = simulator.simulate({
        taskId: 'test',
        complexity: 0.5,
        steps: [
          { index: 0, description: 'Run tool', toolName: 'test_tool', toolArgs: { input: 'hello' } },
        ],
      });

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.estimatedBudget.toolCalls).toBe(1);
    });

    it('should detect missing tools as high severity', () => {
      const simulator = new ExecutionSimulator(tools);
      const result = simulator.simulate({
        taskId: 'test',
        complexity: 0.5,
        steps: [
          { index: 0, description: 'Use missing', toolName: 'nonexistent_tool', toolArgs: {} },
        ],
      });

      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('missing_tool');
      expect(result.issues[0].severity).toBe('high');
    });

    it('should detect invalid args via Zod schema', () => {
      const simulator = new ExecutionSimulator(tools);
      const result = simulator.simulate({
        taskId: 'test',
        complexity: 0.5,
        steps: [
          { index: 0, description: 'Navigate', toolName: 'browser_navigate', toolArgs: { url: 123 as any } },
        ],
      });

      expect(result.valid).toBe(false);
      const argIssue = result.issues.find(i => i.type === 'invalid_args');
      expect(argIssue).toBeDefined();
      expect(argIssue!.severity).toBe('high');
    });

    it('should flag missing dependency when browser action has no prior navigate', () => {
      const simulator = new ExecutionSimulator(tools);
      const result = simulator.simulate({
        taskId: 'test',
        complexity: 0.5,
        steps: [
          { index: 0, description: 'Click', toolName: 'browser_click', toolArgs: { selector: '.btn' } },
        ],
      });

      const depIssue = result.issues.find(i => i.type === 'missing_dependency');
      expect(depIssue).toBeDefined();
      expect(depIssue!.severity).toBe('medium');
    });

    it('should not flag dependency when browser_navigate precedes action', () => {
      const simulator = new ExecutionSimulator(tools);
      const result = simulator.simulate({
        taskId: 'test',
        complexity: 0.5,
        steps: [
          { index: 0, description: 'Navigate', toolName: 'browser_navigate', toolArgs: { url: 'https://example.com' } },
          { index: 1, description: 'Click', toolName: 'browser_click', toolArgs: { selector: '.btn' } },
        ],
      });

      const depIssues = result.issues.filter(i => i.type === 'missing_dependency');
      expect(depIssues).toHaveLength(0);
    });

    it('should flag high-risk tools', () => {
      tools.register({
        name: 'file_write',
        description: 'Write file',
        inputSchema: z.object({ path: z.string(), content: z.string() }).passthrough(),
        outputSchema: z.any(),
        execute: async () => ({ success: true }),
      }, 'builtin');

      const simulator = new ExecutionSimulator(tools);
      const result = simulator.simulate({
        taskId: 'test',
        complexity: 0.5,
        steps: [
          { index: 0, description: 'Write', toolName: 'file_write', toolArgs: { path: '/tmp/test', content: 'data' } },
        ],
      });

      const riskIssue = result.issues.find(i => i.type === 'high_risk');
      expect(riskIssue).toBeDefined();
    });
  });

  describe('Simulation in state machine', () => {
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

    it('should include simulate state transition in trace', async () => {
      const { executor } = buildExecutor([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "hello"}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
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

      expect(transitions).toContain('simulate');
    });

    it('should include simulation_result in trace events', async () => {
      const { executor } = buildExecutor([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
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
      const simEvents = allEvents.filter(e => e.type === 'simulation_result');
      expect(simEvents).toHaveLength(1);
      expect(simEvents[0].data.valid).toBe(true);
    });

    it('should populate simulationResult on TaskResult', async () => {
      const { executor } = buildExecutor([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        'Done.',
      ]);

      const result = await executor.execute(createTask());
      expect(result.simulationResult).toBeDefined();
      expect(result.simulationResult!.valid).toBe(true);
    });

    it('should filter out steps with missing tools', async () => {
      const { executor } = buildExecutor([
        '{"goal": "test", "constraints": [], "successCriteria": []}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Missing", "toolName": "nonexistent_tool", "toolArgs": {}}, {"description": "OK", "toolName": "test_tool", "toolArgs": {}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8, 0.8], "issues": []}',
        'Done.',  // synthesize
        '{}',     // extra in case reactive planning consumes a response
      ]);

      const result = await executor.execute(createTask());

      // Simulation should have flagged the missing tool
      expect(result.simulationResult).toBeDefined();
      expect(result.simulationResult!.issues.some(i => i.type === 'missing_tool')).toBe(true);

      // The nonexistent_tool step should NOT appear in step results
      const nonexistentSteps = result.stepResults.filter(s => s.toolName === 'nonexistent_tool');
      expect(nonexistentSteps).toHaveLength(0);
    });
  });
});
