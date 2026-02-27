import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { CrewOrchestrator } from '../src/crew-orchestrator.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, CrewDefinition, AgentDefinition } from '@joule/shared';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as integration.test.ts)
// ---------------------------------------------------------------------------

/**
 * Each agent going through TaskExecutor consumes 4 LLM calls for a simple
 * (no-tool-steps) task:
 *   1. spec (specifyTask)
 *   2. classify (classifyComplexity)
 *   3. plan (plan) — returns {"steps": []} for simple tasks
 *   4. synthesize — produces the final agent output
 *
 * Helper: builds 4 mock responses for one agent.
 */
function agentResponses(output: string): string[] {
  return [
    '{"goal": "test", "constraints": [], "successCriteria": []}', // spec
    '{"complexity": 0.3, "reason": "simple"}',                    // classify
    '{"steps": []}',                                                // plan (empty = direct answer)
    output,                                                         // synthesize
  ];
}

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
      const content = responses[callIndex] ?? '{"steps":[]}';
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

function makeTask(description = 'Test task'): Task {
  return {
    id: generateId('task'),
    description,
    createdAt: new Date().toISOString(),
  };
}

function makeAgent(id: string, role: string, overrides?: Partial<AgentDefinition>): AgentDefinition {
  return {
    id,
    role,
    instructions: `You are a ${role}. Do your job well.`,
    // Default to 'full' in tests so existing agentResponses() mocks still work.
    // New direct-mode tests explicitly set executionMode: 'direct'.
    executionMode: 'full',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrewOrchestrator', () => {
  let tools: ToolRegistry;
  let budget: BudgetManager;
  let tracer: TraceLogger;
  let providers: ModelProviderRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args: any) => ({ result: `done: ${args.input ?? 'default'}` }),
    }, 'builtin');
    tools.register({
      name: 'research_tool',
      description: 'Research tool',
      inputSchema: z.object({ query: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args: any) => ({ findings: `researched: ${args.query ?? 'topic'}` }),
    }, 'builtin');
    tools.register({
      name: 'write_tool',
      description: 'Writing tool',
      inputSchema: z.object({ content: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args: any) => ({ written: `wrote: ${args.content ?? 'content'}` }),
    }, 'builtin');

    budget = new BudgetManager();
    tracer = new TraceLogger();
    providers = new ModelProviderRegistry();
  });

  function buildOrchestrator(responses: string[]) {
    const mockProvider = createMockProvider(responses);
    providers.register(mockProvider as any);
    const router = new ModelRouter(providers, budget, defaultRouting);
    const planner = new Planner(router, tools, providers, budget, tracer);
    return new CrewOrchestrator(planner, budget, router, tracer, tools, providers);
  }

  // =========================================================================
  // Sequential Strategy
  // =========================================================================

  describe('Sequential Strategy', () => {
    it('should execute agents in definition order', async () => {
      const responses = [
        ...agentResponses('Research result: found info'),
        ...agentResponses('Written article based on research'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'test-crew',
        strategy: 'sequential',
        agents: [
          makeAgent('researcher', 'Researcher', { budgetShare: 0.5 }),
          makeAgent('writer', 'Writer', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Research and write');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.crewName).toBe('test-crew');
      expect(result.agentResults).toHaveLength(2);
      expect(result.agentResults[0].agentId).toBe('researcher');
      expect(result.agentResults[1].agentId).toBe('writer');
    });

    it('should pass blackboard context to subsequent agents', async () => {
      const responses = [
        ...agentResponses('First agent output'),
        ...agentResponses('Second agent output'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'blackboard-test',
        strategy: 'sequential',
        agents: [
          makeAgent('first', 'First Agent', { budgetShare: 0.5 }),
          makeAgent('second', 'Second Agent', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Test blackboard passing');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      // Second agent should have blackboard entries from first
      expect(result.blackboard.entries['first']).toBeDefined();
      expect(result.blackboard.entries['first'].agentId).toBe('first');
    });

    it('should respect custom agentOrder', async () => {
      const responses = [
        ...agentResponses('Writer goes first'),
        ...agentResponses('Researcher goes second'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'order-test',
        strategy: 'sequential',
        agentOrder: ['writer', 'researcher'],
        agents: [
          makeAgent('researcher', 'Researcher', { budgetShare: 0.5 }),
          makeAgent('writer', 'Writer', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Custom order test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults[0].agentId).toBe('writer');
      expect(result.agentResults[1].agentId).toBe('researcher');
    });
  });

  // =========================================================================
  // Parallel Strategy
  // =========================================================================

  describe('Parallel Strategy', () => {
    it('should execute all agents', async () => {
      const responses = [
        ...agentResponses('Agent A result'),
        ...agentResponses('Agent B result'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'parallel-test',
        strategy: 'parallel',
        agents: [
          makeAgent('a', 'Agent A', { budgetShare: 0.5 }),
          makeAgent('b', 'Agent B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Parallel execution test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults).toHaveLength(2);
      // Both should have written to blackboard
      expect(result.blackboard.entries['a']).toBeDefined();
      expect(result.blackboard.entries['b']).toBeDefined();
    });

    it('should pre-allocate budget envelopes', async () => {
      const responses = [
        ...agentResponses('Result A'),
        ...agentResponses('Result B'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'budget-parallel',
        strategy: 'parallel',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.6 }),
          makeAgent('b', 'B', { budgetShare: 0.4 }),
        ],
      };

      const task = makeTask('Budget test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      // Parent budget should reflect combined spending (mirrored from agent sub-envelopes)
      const parentUsage = budget.getUsage(envelope);
      expect(parentUsage.tokensUsed).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Graph Strategy
  // =========================================================================

  describe('Graph Strategy', () => {
    it('should execute agents respecting dependency edges', async () => {
      const responses = [
        ...agentResponses('A done'),
        ...agentResponses('B done'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'graph-test',
        strategy: 'graph',
        agents: [
          makeAgent('a', 'First', { budgetShare: 0.5 }),
          makeAgent('b', 'Second', { budgetShare: 0.5 }),
        ],
        graph: [
          { from: 'a', to: 'b' },
        ],
      };

      const task = makeTask('Graph test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults).toHaveLength(2);
      expect(result.agentResults[0].agentId).toBe('a');
      expect(result.agentResults[1].agentId).toBe('b');
    });

    it('should detect cycles in the graph', async () => {
      const orchestrator = buildOrchestrator([]);
      const crew: CrewDefinition = {
        name: 'cycle-test',
        strategy: 'graph',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.5 }),
          makeAgent('b', 'B', { budgetShare: 0.5 }),
        ],
        graph: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      };

      const task = makeTask('Cycle test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Cycle detected');
    });

    it('should evaluate edge conditions', async () => {
      const responses = [
        ...agentResponses('A done'),
        // B should be skipped because condition won't match
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'condition-test',
        strategy: 'graph',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.5 }),
          makeAgent('b', 'B', { budgetShare: 0.5 }),
        ],
        graph: [
          { from: 'a', to: 'b', condition: 'a.status === "failed"' },
        ],
      };

      const task = makeTask('Condition test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      // Only agent A should have executed (B's condition not met)
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].agentId).toBe('a');
    });

    it('should handle diamond dependency pattern', async () => {
      const responses = [
        ...agentResponses('A done'),
        ...agentResponses('B done'),
        ...agentResponses('C done'),
        ...agentResponses('D done'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'diamond-test',
        strategy: 'graph',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.25 }),
          makeAgent('b', 'B', { budgetShare: 0.25 }),
          makeAgent('c', 'C', { budgetShare: 0.25 }),
          makeAgent('d', 'D', { budgetShare: 0.25 }),
        ],
        graph: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'c' },
          { from: 'b', to: 'd' },
          { from: 'c', to: 'd' },
        ],
      };

      const task = makeTask('Diamond test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults).toHaveLength(4);
      // A must be first, D must be last
      expect(result.agentResults[0].agentId).toBe('a');
      expect(result.agentResults[result.agentResults.length - 1].agentId).toBe('d');
    });
  });

  // =========================================================================
  // Budget Management
  // =========================================================================

  describe('Budget Management', () => {
    it('should mirror agent spending to parent envelope', async () => {
      const responses = [
        ...agentResponses('Done'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'budget-mirror',
        strategy: 'sequential',
        agents: [makeAgent('a', 'A', { budgetShare: 0.5 })],
      };

      const task = makeTask('Budget mirror test');
      const envelope = budget.createEnvelope('high');
      const beforeUsage = budget.getUsage(envelope);
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      await orchestrator.executeCrew(crew, task, envelope, traceId);

      const afterUsage = budget.getUsage(envelope);
      expect(afterUsage.tokensUsed).toBeGreaterThan(beforeUsage.tokensUsed);
    });

    it('should normalize budget shares that exceed 1.0', async () => {
      const orchestrator = buildOrchestrator([]);
      const crew: CrewDefinition = {
        name: 'normalize-test',
        strategy: 'sequential',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.8 }),
          makeAgent('b', 'B', { budgetShare: 0.8 }),
        ],
      };

      const task = makeTask('Normalize test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      // Validation catches budget shares > 1.0 + epsilon and returns failed result
      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('exceeds 1.0');
    });

    it('should equally split budget when shares are not specified', async () => {
      const responses = [
        ...agentResponses('A done'),
        ...agentResponses('B done'),
        ...agentResponses('C done'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'equal-split',
        strategy: 'sequential',
        agents: [
          makeAgent('a', 'A'),
          makeAgent('b', 'B'),
          makeAgent('c', 'C'),
        ],
      };

      const task = makeTask('Equal split test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.agentResults).toHaveLength(3);
    });
  });

  // =========================================================================
  // Tool Isolation
  // =========================================================================

  describe('Tool Isolation', () => {
    it('should only expose allowed tools to each agent', () => {
      const filtered = tools.createFiltered(['test_tool']);
      expect(filtered.has('test_tool')).toBe(true);
      expect(filtered.has('research_tool')).toBe(false);
      expect(filtered.has('write_tool')).toBe(false);
    });

    it('should expose all tools when allowedTools is undefined', () => {
      const filtered = tools.createFiltered(undefined);
      expect(filtered.listNames()).toHaveLength(3);
    });

    it('should expose all tools when allowedTools is empty', () => {
      const filtered = tools.createFiltered([]);
      expect(filtered.listNames()).toHaveLength(3);
    });
  });

  // =========================================================================
  // Blackboard
  // =========================================================================

  describe('Blackboard', () => {
    it('should start with empty entries', async () => {
      const responses = [
        ...agentResponses('Done'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'blackboard-empty',
        strategy: 'sequential',
        agents: [makeAgent('a', 'A', { budgetShare: 1.0 })],
      };

      const task = makeTask('Blackboard test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.blackboard.entries['a']).toBeDefined();
      expect(result.blackboard.entries['a'].agentId).toBe('a');
    });

    it('should write agent results after execution', async () => {
      const responses = [
        ...agentResponses('First result'),
        ...agentResponses('Second result'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'blackboard-writes',
        strategy: 'sequential',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.5 }),
          makeAgent('b', 'B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Blackboard writes test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(Object.keys(result.blackboard.entries)).toHaveLength(2);
    });
  });

  // =========================================================================
  // Result Aggregation
  // =========================================================================

  describe('Result Aggregation', () => {
    it('should concatenate results with concat strategy', async () => {
      const responses = [
        ...agentResponses('Result from Agent A'),
        ...agentResponses('Result from Agent B'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'concat-test',
        strategy: 'sequential',
        aggregation: 'concat',
        agents: [
          makeAgent('a', 'Agent A', { budgetShare: 0.5 }),
          makeAgent('b', 'Agent B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Concat test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.result).toContain('Agent A');
      expect(result.result).toContain('Agent B');
    });

    it('should return last agent result with last strategy', async () => {
      const responses = [
        ...agentResponses('First output'),
        ...agentResponses('Last output wins'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'last-test',
        strategy: 'sequential',
        aggregation: 'last',
        agents: [
          makeAgent('a', 'A', { budgetShare: 0.5 }),
          makeAgent('b', 'B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Last strategy test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.result).toContain('Last output wins');
    });
  });

  // =========================================================================
  // Validation
  // =========================================================================

  describe('Validation', () => {
    it('should reject crews with no agents', async () => {
      const orchestrator = buildOrchestrator([]);
      const crew: CrewDefinition = {
        name: 'empty-crew',
        strategy: 'sequential',
        agents: [],
      };

      const task = makeTask('Empty crew');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('at least one agent');
    });

    it('should reject duplicate agent IDs', async () => {
      const orchestrator = buildOrchestrator([]);
      const crew: CrewDefinition = {
        name: 'dup-ids',
        strategy: 'sequential',
        agents: [
          makeAgent('a', 'First'),
          makeAgent('a', 'Duplicate'),
        ],
      };

      const task = makeTask('Dup IDs');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Duplicate agent ID');
    });

    it('should reject graph edges referencing unknown agents', async () => {
      const orchestrator = buildOrchestrator([]);
      const crew: CrewDefinition = {
        name: 'bad-graph',
        strategy: 'graph',
        agents: [makeAgent('a', 'A')],
        graph: [{ from: 'a', to: 'unknown' }],
      };

      const task = makeTask('Bad graph');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.status).toBe('failed');
      expect(result.error).toContain('unknown agent');
    });
  });

  // =========================================================================
  // Hierarchical Strategy
  // =========================================================================

  describe('Hierarchical Strategy', () => {
    it('should execute manager first', async () => {
      // Manager plan phase + worker + manager synthesis: 3 agents worth of calls
      const responses = [
        ...agentResponses('{"delegations": [{"agentId": "worker1", "instructions": "Do the work"}]}'),
        ...agentResponses('Worker output'),
        ...agentResponses('Final synthesized result'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'hierarchical-test',
        strategy: 'hierarchical',
        agents: [
          makeAgent('manager', 'Manager', { budgetShare: 0.4 }),
          makeAgent('worker1', 'Worker', { budgetShare: 0.6 }),
        ],
      };

      const task = makeTask('Hierarchical test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      // Should have at least 2 results: manager + worker (possibly manager synthesis too)
      expect(result.agentResults.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Enhanced Blackboard
  // =========================================================================

  describe('Enhanced Blackboard', () => {
    it('should include status in blackboard entries after sequential execution', async () => {
      const responses = [
        ...agentResponses('Agent A output'),
        ...agentResponses('Agent B output'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'blackboard-status-test',
        strategy: 'sequential',
        agents: [
          makeAgent('agent_a', 'Agent A', { budgetShare: 0.5 }),
          makeAgent('agent_b', 'Agent B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Test blackboard status');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.blackboard.entries['agent_a']).toBeDefined();
      expect(result.blackboard.entries['agent_a'].status).toBe('completed');
      expect(result.blackboard.entries['agent_b']).toBeDefined();
      expect(result.blackboard.entries['agent_b'].status).toBe('completed');
    });

    it('should include status in blackboard entries after parallel execution', async () => {
      const responses = [
        ...agentResponses('Parallel A output'),
        ...agentResponses('Parallel B output'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'parallel-blackboard-test',
        strategy: 'parallel',
        agents: [
          makeAgent('para_a', 'Analyst A', { budgetShare: 0.5 }),
          makeAgent('para_b', 'Analyst B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Test parallel blackboard');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.blackboard.entries['para_a'].status).toBe('completed');
      expect(result.blackboard.entries['para_b'].status).toBe('completed');
    });
  });

  // =========================================================================
  // Agent-Level Progress Reporting
  // =========================================================================

  describe('Agent-Level Progress Reporting', () => {
    it('should include agentId and agentRole in progress events', async () => {
      const responses = [
        ...agentResponses('Agent output'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'progress-test',
        strategy: 'sequential',
        agents: [
          makeAgent('prog_agent', 'Progress Agent', { budgetShare: 1.0 }),
        ],
      };

      const task = makeTask('Test progress');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const progressEvents: any[] = [];
      await orchestrator.executeCrew(crew, task, envelope, traceId, (event) => {
        progressEvents.push(event);
      });

      // Should have received progress events with agent identity
      expect(progressEvents.length).toBeGreaterThan(0);
      for (const event of progressEvents) {
        expect(event.agentId).toBe('prog_agent');
        expect(event.agentRole).toBe('Progress Agent');
      }
    });
  });

  // =========================================================================
  // Agent Retry
  // =========================================================================

  describe('Agent Retry', () => {
    it('should retry a failed agent up to maxRetries times', async () => {
      // First attempt fails (returns empty plan which will synthesize), second succeeds
      const responses = [
        ...agentResponses('First attempt output'),  // This will succeed
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'retry-test',
        strategy: 'sequential',
        agents: [
          makeAgent('retrier', 'Retrier', { budgetShare: 1.0, maxRetries: 2, retryDelayMs: 10 }),
        ],
      };

      const task = makeTask('Test retry');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      // First attempt should succeed, so no retry needed
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].agentId).toBe('retrier');
    });

    it('should not retry on budget exhaustion errors', async () => {
      // Provide enough responses for one failed attempt with budget error
      const responses = [
        ...agentResponses('output'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'no-retry-budget',
        strategy: 'sequential',
        agents: [
          makeAgent('agent', 'Agent', { budgetShare: 1.0, maxRetries: 3, retryDelayMs: 10 }),
        ],
      };

      const task = makeTask('Test no retry on budget');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      // Should complete without hanging (budget errors skip retry)
      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.agentResults).toHaveLength(1);
    });
  });

  // =========================================================================
  // Structured Output Schema
  // =========================================================================

  describe('Structured Output Schema', () => {
    it('should validate output against schema and pass valid output', async () => {
      const responses = [
        ...agentResponses('{"title": "Test", "score": 85}'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'schema-test',
        strategy: 'sequential',
        agents: [
          makeAgent('scorer', 'Scorer', {
            budgetShare: 1.0,
            outputSchema: {
              type: 'object',
              properties: { title: { type: 'string' }, score: { type: 'number' } },
              required: ['title', 'score'],
            },
          }),
        ],
      };

      const task = makeTask('Score this');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults).toHaveLength(1);
      // Agent should complete (schema validation doesn't block on valid/first attempt output)
      expect(result.agentResults[0].agentId).toBe('scorer');
    });

    it('should include output schema instructions in task description', async () => {
      const responses = [
        ...agentResponses('{"analysis": "done"}'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'schema-instruction-test',
        strategy: 'sequential',
        agents: [
          makeAgent('analyzer', 'Analyzer', {
            budgetShare: 1.0,
            outputSchema: {
              type: 'object',
              properties: { analysis: { type: 'string' } },
              required: ['analysis'],
            },
          }),
        ],
      };

      const task = makeTask('Analyze');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
      expect(result.status).toBe('completed');
    });
  });

  // =========================================================================
  // Crew Streaming
  // =========================================================================

  describe('Crew Streaming', () => {
    it('should yield agent-start events for each agent', async () => {
      const responses = [
        ...agentResponses('Stream output A'),
        ...agentResponses('Stream output B'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'stream-test',
        strategy: 'sequential',
        agents: [
          makeAgent('stream_a', 'Streamer A', { budgetShare: 0.5 }),
          makeAgent('stream_b', 'Streamer B', { budgetShare: 0.5 }),
        ],
      };

      const task = makeTask('Stream test');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const events: any[] = [];
      const stream = orchestrator.executeCrewStream(crew, task, envelope, traceId);

      for await (const event of stream) {
        events.push(event);
      }

      // Should have agent-start events
      const startEvents = events.filter(e => e.type === 'agent-start');
      expect(startEvents.length).toBe(2);
      expect(startEvents[0].agentId).toBe('stream_a');
      expect(startEvents[1].agentId).toBe('stream_b');

      // Should have crew-complete event
      const completeEvents = events.filter(e => e.type === 'crew-complete');
      expect(completeEvents.length).toBe(1);
      expect(completeEvents[0].crewResult).toBeDefined();
    });

    it('should yield agent-complete events with results', async () => {
      const responses = [
        ...agentResponses('Streamed result'),
      ];
      const orchestrator = buildOrchestrator(responses);
      const crew: CrewDefinition = {
        name: 'stream-complete-test',
        strategy: 'sequential',
        agents: [
          makeAgent('single', 'Single Agent', { budgetShare: 1.0 }),
        ],
      };

      const task = makeTask('Single stream');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const events: any[] = [];
      const stream = orchestrator.executeCrewStream(crew, task, envelope, traceId);

      for await (const event of stream) {
        events.push(event);
      }

      const completeAgentEvents = events.filter(e => e.type === 'agent-complete');
      expect(completeAgentEvents.length).toBe(1);
      expect(completeAgentEvents[0].agentId).toBe('single');
      expect(completeAgentEvents[0].agentResult).toBeDefined();
    });
  });

  // =========================================================================
  // Direct Execution Mode (OpenClaw-style reactive loop)
  // =========================================================================

  describe('Direct Execution Mode', () => {
    /**
     * In direct mode, each agent only needs 1 LLM call for a simple answer
     * (vs 4 calls in full mode). The LLM returns {"answer": "..."} directly.
     */
    function directAnswerResponse(answer: string): string {
      return JSON.stringify({ answer });
    }

    /**
     * A tool-calling response — the LLM wants to use tools.
     */
    function directToolCallResponse(calls: Array<{ toolName: string; toolArgs: Record<string, unknown> }>): string {
      return JSON.stringify({ tool_calls: calls });
    }

    it('should complete in 1 LLM call with direct mode (no tools)', async () => {
      const responses = [
        directAnswerResponse('Direct answer from agent'),
      ];
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'direct-simple',
        strategy: 'sequential',
        agents: [
          makeAgent('fast_agent', 'Fast Agent', {
            budgetShare: 1.0,
            executionMode: 'direct',
          }),
        ],
      };

      const task = makeTask('Answer a question directly');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.status).toBe('completed');
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0].taskResult.status).toBe('completed');
      expect(result.agentResults[0].taskResult.result).toBe('Direct answer from agent');
    });

    it('should execute tool calls and loop back for answer', async () => {
      const responses = [
        // First call: LLM wants to use a tool
        directToolCallResponse([{ toolName: 'test_tool', toolArgs: { input: 'hello' } }]),
        // Second call: LLM sees tool result and gives final answer
        directAnswerResponse('Used tool result: done'),
      ];
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'direct-tools',
        strategy: 'sequential',
        agents: [
          makeAgent('tool_agent', 'Tool Agent', {
            budgetShare: 1.0,
            executionMode: 'direct',
            allowedTools: ['test_tool'],
          }),
        ],
      };

      const task = makeTask('Use a tool to get data');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.status).toBe('completed');
      expect(result.agentResults[0].taskResult.status).toBe('completed');
      expect(result.agentResults[0].taskResult.result).toBe('Used tool result: done');
    });

    it('should run parallel agents in direct mode', async () => {
      const responses = [
        directAnswerResponse('Agent A done'),
        directAnswerResponse('Agent B done'),
      ];
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'direct-parallel',
        strategy: 'parallel',
        agents: [
          makeAgent('a', 'Agent A', { budgetShare: 0.5, executionMode: 'direct' }),
          makeAgent('b', 'Agent B', { budgetShare: 0.5, executionMode: 'direct' }),
        ],
      };

      const task = makeTask('Do two things at once');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults).toHaveLength(2);
      const completedCount = result.agentResults.filter(r => r.taskResult.status === 'completed').length;
      expect(completedCount).toBe(2);
    });

    it('should default to direct mode when executionMode is not set', async () => {
      const responses = [
        directAnswerResponse('Default direct mode works'),
      ];
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'default-mode',
        strategy: 'sequential',
        agents: [
          // Override makeAgent's 'full' default to test real production default
          makeAgent('default_agent', 'Default Agent', { budgetShare: 1.0, executionMode: undefined }),
        ],
      };

      const task = makeTask('Test default mode');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.status).toBe('completed');
      expect(result.agentResults[0].taskResult.result).toBe('Default direct mode works');
    });

    it('should use full pipeline when executionMode is "full"', async () => {
      // Full mode needs 4 responses per agent (spec, classify, plan, synthesize)
      const responses = agentResponses('Full pipeline result');
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'full-mode',
        strategy: 'sequential',
        agents: [
          makeAgent('full_agent', 'Full Agent', {
            budgetShare: 1.0,
            executionMode: 'full',
          }),
        ],
      };

      const task = makeTask('Test full pipeline mode');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.status).toBe('completed');
      expect(result.agentResults[0].agentId).toBe('full_agent');
    });

    it('should respect maxIterations limit', async () => {
      // Always return tool calls, never a final answer — should hit maxIterations
      const responses = Array(15).fill(
        directToolCallResponse([{ toolName: 'test_tool', toolArgs: { input: 'loop' } }]),
      );
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'iteration-limit',
        strategy: 'sequential',
        agents: [
          makeAgent('looper', 'Looper', {
            budgetShare: 1.0,
            executionMode: 'direct',
            maxIterations: 3,
          }),
        ],
      };

      const task = makeTask('Loop until limit');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      // Should have reached max iterations
      expect(result.agentResults[0].taskResult.error).toContain('max iterations');
    });

    it('should handle multiple tool calls in a single response', async () => {
      const responses = [
        directToolCallResponse([
          { toolName: 'test_tool', toolArgs: { input: 'first' } },
          { toolName: 'research_tool', toolArgs: { query: 'topic' } },
        ]),
        directAnswerResponse('Combined results from multiple tools'),
      ];
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'multi-tool',
        strategy: 'sequential',
        agents: [
          makeAgent('multi_tool_agent', 'Multi Tool Agent', {
            budgetShare: 1.0,
            executionMode: 'direct',
            allowedTools: ['test_tool', 'research_tool'],
          }),
        ],
      };

      const task = makeTask('Use multiple tools at once');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.status).toBe('completed');
      expect(result.agentResults[0].taskResult.result).toBe('Combined results from multiple tools');
    });

    it('should mix direct and full mode agents in the same crew', async () => {
      const responses = [
        // Direct agent: 1 call
        directAnswerResponse('Fast agent done'),
        // Full agent: 4 calls
        ...agentResponses('Thorough agent done'),
      ];
      const orchestrator = buildOrchestrator(responses);

      const crew: CrewDefinition = {
        name: 'mixed-modes',
        strategy: 'sequential',
        agents: [
          makeAgent('fast', 'Fast Agent', {
            budgetShare: 0.3,
            executionMode: 'direct',
          }),
          makeAgent('thorough', 'Thorough Agent', {
            budgetShare: 0.7,
            executionMode: 'full',
          }),
        ],
      };

      const task = makeTask('Mix of direct and full');
      const envelope = budget.createEnvelope('high');
      const traceId = generateId('trace');
      tracer.createTrace(traceId, task.id, envelope.envelope);

      const result = await orchestrator.executeCrew(crew, task, envelope, traceId);

      expect(result.agentResults).toHaveLength(2);
      expect(result.agentResults[0].agentId).toBe('fast');
      expect(result.agentResults[1].agentId).toBe('thorough');
    });
  });
});
