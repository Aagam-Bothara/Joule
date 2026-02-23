import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { DecisionGraphBuilder } from '../src/decision-graph.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, ExecutionTrace, TraceSpan, TraceEvent } from '@joule/shared';

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
    description: 'Decision graph test task',
    budget: 'high' as any,
    createdAt: new Date().toISOString(),
  };
}

describe('Decision Graph Builder', () => {
  let tools: ToolRegistry;
  let graphBuilder: DecisionGraphBuilder;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ result: `done: ${args.input ?? 'default'}` }),
    }, 'builtin');

    graphBuilder = new DecisionGraphBuilder();
  });

  describe('buildFromTrace', () => {
    it('should build a graph from a simple execution trace', () => {
      const budget = new BudgetManager();
      const tracer = new TraceLogger();
      const providers = new ModelProviderRegistry();
      providers.register(createMockProvider([]) as any);
      const router = new ModelRouter(providers, budget, defaultRouting);
      const planner = new Planner(router, tools, providers, budget, tracer);
      const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, defaultRouting);

      // We can't easily run execute here without proper mock responses,
      // so build a trace manually with known events
      const traceId = generateId('trace');
      tracer.createTrace(traceId, 'test-task', { maxTokens: 1000, maxToolCalls: 10, maxEscalations: 2, costCeilingUsd: 1, maxLatencyMs: 60000 });

      const spanId = tracer.startSpan(traceId, 'test-execution');
      tracer.logEvent(traceId, 'state_transition', { from: 'idle', to: 'spec' });
      tracer.logEvent(traceId, 'state_transition', { from: 'spec', to: 'plan' });
      tracer.logEvent(traceId, 'state_transition', { from: 'plan', to: 'act' });
      tracer.logEvent(traceId, 'state_transition', { from: 'act', to: 'done' });
      tracer.endSpan(traceId, spanId);

      const trace = tracer.getTrace(traceId, { tokensUsed: 0, tokensRemaining: 1000, toolCallsUsed: 0, toolCallsRemaining: 10, escalationsUsed: 0, escalationsRemaining: 2, costUsd: 0, costRemaining: 1, elapsedMs: 100, latencyRemaining: 59900 });

      const graph = graphBuilder.buildFromTrace('test-task', trace);

      expect(graph.taskId).toBe('test-task');
      expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
      expect(graph.edges.length).toBeGreaterThan(0);
      expect(graph.criticalPath.length).toBeGreaterThan(0);
    });

    it('should create nodes for routing decisions', () => {
      const traceId = generateId('trace');
      const tracer = new TraceLogger();
      tracer.createTrace(traceId, 'test', { maxTokens: 1000, maxToolCalls: 10, maxEscalations: 2, costCeilingUsd: 1, maxLatencyMs: 60000 });

      const spanId = tracer.startSpan(traceId, 'test');
      tracer.logEvent(traceId, 'routing_decision', {
        tier: 'SLM',
        provider: 'ollama',
        model: 'test-slm',
        reason: 'Low complexity, using SLM',
        estimatedCost: 0.001,
      });
      tracer.endSpan(traceId, spanId);

      const trace = tracer.getTrace(traceId, { tokensUsed: 0, tokensRemaining: 1000, toolCallsUsed: 0, toolCallsRemaining: 10, escalationsUsed: 0, escalationsRemaining: 2, costUsd: 0, costRemaining: 1, elapsedMs: 100, latencyRemaining: 59900 });

      const graph = graphBuilder.buildFromTrace('test', trace);

      const routingNode = graph.nodes.find(n => n.phase === 'act' && n.decision.includes('Routed'));
      expect(routingNode).toBeDefined();
      expect(routingNode!.rationale).toContain('Low complexity');
    });

    it('should create triggered edges from escalation events', () => {
      const traceId = generateId('trace');
      const tracer = new TraceLogger();
      tracer.createTrace(traceId, 'test', { maxTokens: 1000, maxToolCalls: 10, maxEscalations: 2, costCeilingUsd: 1, maxLatencyMs: 60000 });

      const spanId = tracer.startSpan(traceId, 'test');
      tracer.logEvent(traceId, 'escalation', {
        reason: 'Step 0 failed: timeout',
        step: 0,
        replanDepth: 0,
      });
      tracer.logEvent(traceId, 'replan', {
        reason: 'Recovery from step failure',
      });
      tracer.endSpan(traceId, spanId);

      const trace = tracer.getTrace(traceId, { tokensUsed: 0, tokensRemaining: 1000, toolCallsUsed: 0, toolCallsRemaining: 10, escalationsUsed: 0, escalationsRemaining: 2, costUsd: 0, costRemaining: 1, elapsedMs: 100, latencyRemaining: 59900 });

      const graph = graphBuilder.buildFromTrace('test', trace);

      const triggeredEdge = graph.edges.find(e => e.type === 'triggered');
      expect(triggeredEdge).toBeDefined();
    });

    it('should produce empty graph for empty trace', () => {
      const traceId = generateId('trace');
      const tracer = new TraceLogger();
      tracer.createTrace(traceId, 'test', { maxTokens: 1000, maxToolCalls: 10, maxEscalations: 2, costCeilingUsd: 1, maxLatencyMs: 60000 });

      const trace = tracer.getTrace(traceId, { tokensUsed: 0, tokensRemaining: 1000, toolCallsUsed: 0, toolCallsRemaining: 10, escalationsUsed: 0, escalationsRemaining: 2, costUsd: 0, costRemaining: 1, elapsedMs: 100, latencyRemaining: 59900 });

      const graph = graphBuilder.buildFromTrace('test', trace);

      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
      expect(graph.criticalPath).toHaveLength(0);
    });

    it('should handle plan_critique events as decision nodes', () => {
      const traceId = generateId('trace');
      const tracer = new TraceLogger();
      tracer.createTrace(traceId, 'test', { maxTokens: 1000, maxToolCalls: 10, maxEscalations: 2, costCeilingUsd: 1, maxLatencyMs: 60000 });

      const spanId = tracer.startSpan(traceId, 'test');
      tracer.logEvent(traceId, 'plan_critique', {
        overall: 0.85,
        issueCount: 1,
      });
      tracer.endSpan(traceId, spanId);

      const trace = tracer.getTrace(traceId, { tokensUsed: 0, tokensRemaining: 1000, toolCallsUsed: 0, toolCallsRemaining: 10, escalationsUsed: 0, escalationsRemaining: 2, costUsd: 0, costRemaining: 1, elapsedMs: 100, latencyRemaining: 59900 });

      const graph = graphBuilder.buildFromTrace('test', trace);

      const critiqueNode = graph.nodes.find(n => n.phase === 'critique');
      expect(critiqueNode).toBeDefined();
      expect(critiqueNode!.confidence).toBe(0.85);
      expect(critiqueNode!.decision).toContain('0.85');
    });
  });

  describe('findCriticalPath', () => {
    it('should return longest path through decision nodes', () => {
      const nodes = [
        { id: 'a', phase: 'idle' as any, decision: 'Start', rationale: '', confidence: 1, alternatives: [], timestamp: 1, children: [] },
        { id: 'b', phase: 'plan' as any, decision: 'Plan', rationale: '', confidence: 1, alternatives: [], timestamp: 2, children: [] },
        { id: 'c', phase: 'act' as any, decision: 'Act', rationale: '', confidence: 1, alternatives: [], timestamp: 3, children: [] },
      ];
      const edges = [
        { from: 'a', to: 'b', type: 'led_to' as const },
        { from: 'b', to: 'c', type: 'led_to' as const },
      ];

      const path = graphBuilder.findCriticalPath(nodes, edges);
      expect(path).toEqual(['a', 'b', 'c']);
    });
  });
});
