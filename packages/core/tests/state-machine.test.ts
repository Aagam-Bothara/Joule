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

function buildExecutor(responses: string[], tools: ToolRegistry, routing = defaultRouting) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  providers.register(createMockProvider(responses) as any);
  const router = new ModelRouter(providers, budget, routing);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, routing);
  return { executor, budget, tracer };
}

function createTask(): Task {
  return {
    id: generateId('task'),
    description: 'State machine test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('State Machine Controller', () => {
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

  it('should transition through all states: idle → spec → plan → act → synthesize → done', async () => {
    const { executor, tracer } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": [{"description": "done", "type": "tool_succeeded", "check": {}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "hello"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Result synthesized.',
    ], tools);

    const result = await executor.execute(createTask());

    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].success).toBe(true);

    // Check state transitions in trace
    const trace = result.trace;
    function collectEvents(spans: typeof trace.spans): typeof trace.spans[0]['events'] {
      const events: typeof trace.spans[0]['events'] = [];
      for (const span of spans) {
        events.push(...span.events);
        events.push(...collectEvents(span.children));
      }
      return events;
    }

    const allEvents = collectEvents(trace.spans);
    const transitions = allEvents
      .filter(e => e.type === 'state_transition')
      .map(e => ({ from: e.data.from, to: e.data.to }));

    // Should see: idle, spec, plan, act, synthesize, done
    const states = transitions.map(t => t.to);
    expect(states).toContain('idle');
    expect(states).toContain('spec');
    expect(states).toContain('plan');
    expect(states).toContain('act');
    expect(states).toContain('synthesize');
    expect(states).toContain('done');
  });

  it('should include spec and criteriaResults in TaskResult', async () => {
    const { executor } = buildExecutor([
      '{"goal": "run test tool", "constraints": ["no side effects"], "successCriteria": [{"description": "tool succeeds", "type": "tool_succeeded", "check": {"toolName": "test_tool"}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());

    expect(result.spec).toBeDefined();
    expect(result.spec!.goal).toBe('run test tool');
    expect(result.spec!.constraints).toContain('no side effects');
    expect(result.criteriaResults).toBeDefined();
    expect(result.criteriaResults!.length).toBe(1);
    expect(result.criteriaResults![0].met).toBe(true);
    expect(result.criteriaResults![0].evidence).toContain('test_tool');
  });

  it('should gracefully degrade when specifyTask returns unparseable JSON', async () => {
    const { executor } = buildExecutor([
      'This is not JSON at all!!!',  // spec fails → fallback
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());

    expect(result.status).toBe('completed');
    // Fallback spec should still be present
    expect(result.spec).toBeDefined();
    expect(result.spec!.goal).toBeTruthy();
    expect(result.spec!.successCriteria.length).toBeGreaterThan(0);
  });

  it('should include state in progress events', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const progressEvents: any[] = [];
    await executor.execute(createTask(), (event) => {
      progressEvents.push(event);
    });

    // Should see specifying, planning, executing, synthesizing phases
    const phases = progressEvents.map(e => e.phase);
    expect(phases).toContain('specifying');
    expect(phases).toContain('planning');
    expect(phases).toContain('executing');
    expect(phases).toContain('synthesizing');
  });

  it('should handle recovery via state machine when step fails', async () => {
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
      '{"steps": [{"description": "Fail", "toolName": "failing_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      '{"steps": [{"description": "Recover", "toolName": "test_tool", "toolArgs": {}}]}',
      'Recovered.',
    ], tools);

    const result = await executor.execute(createTask());

    expect(result.status).toBe('completed');
    expect(result.stepResults.some(s => !s.success)).toBe(true);
    expect(result.stepResults.some(s => s.success)).toBe(true);
  });

  it('should log spec_generated event in trace', async () => {
    const { executor } = buildExecutor([
      '{"goal": "my goal", "constraints": ["c1"], "successCriteria": [{"description": "d", "type": "custom", "check": {}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const result = await executor.execute(createTask());
    const trace = result.trace;

    function collectEvents(spans: typeof trace.spans): typeof trace.spans[0]['events'] {
      const events: typeof trace.spans[0]['events'] = [];
      for (const span of spans) {
        events.push(...span.events);
        events.push(...collectEvents(span.children));
      }
      return events;
    }

    const allEvents = collectEvents(trace.spans);
    const specEvents = allEvents.filter(e => e.type === 'spec_generated');
    expect(specEvents.length).toBe(1);
    expect(specEvents[0].data.goal).toBe('my goal');
    expect(specEvents[0].data.constraintCount).toBe(1);
    expect(specEvents[0].data.criteriaCount).toBe(1);
  });
});
