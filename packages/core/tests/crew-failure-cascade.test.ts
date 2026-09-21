import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager, type BudgetEnvelopeInstance } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { CrewOrchestrator } from '../src/crew-orchestrator.js';
import { renderCrewDiagnostic } from '../src/adaptive/lifecycle.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { AgentDefinition, AgentResult, CrewDefinition, RoutingConfig, Task } from '@joule/shared';

/**
 * Datasets E and E2 showed one shape fifteen times out of fifteen: an agent in
 * a sequential crew fails, and every agent after it makes zero model calls.
 *
 * The cause is not budget, routing or any policy. A failed agent writes
 * `undefined` to the blackboard, and the next agent's context builder called
 * `JSON.stringify(undefined).slice(...)` — a TypeError thrown before that agent
 * could reach a model. Every later agent then hit the same entry, so one
 * failure silently removed the rest of the crew.
 *
 * These tests script the failure deterministically — no network, no paid
 * provider — and pin the contract the orchestrator already documents: the
 * pipeline continues, and the failure stays visible.
 */

const ROLES = ['Implementer', 'Reviewer', 'Tester', 'Researcher'] as const;

interface ProviderScript {
  /** Throw on any call whose system prompt names this role */
  throwFor?: string;
  /** Tokens each call reports; large values exhaust an agent's envelope */
  tokensPerCall?: number;
  /** Reply with a tool call instead of an answer, so the loop keeps going */
  loopFor?: string;
}

function createMockProvider(script: ProviderScript) {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      name: 'ollama' as const,
      supportedTiers: [ModelTier.SLM, ModelTier.MID, ModelTier.LLM],
      isAvailable: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([
        { id: 'test-slm', name: 'Test SLM', tier: ModelTier.SLM, provider: 'ollama' },
        { id: 'test-llm', name: 'Test LLM', tier: ModelTier.LLM, provider: 'ollama' },
      ]),
      estimateCost: vi.fn().mockReturnValue(0.001),
      chat: vi.fn().mockImplementation(async (request: { system?: string }) => {
        const system = request.system ?? '';
        const role = ROLES.find(r => system.includes(`You are: ${r}`)) ?? 'unknown';
        calls.push(role);

        if (script.throwFor && role === script.throwFor) {
          throw new Error('Provider refused the call (scripted)');
        }

        const total = script.tokensPerCall ?? 150;
        const content = script.loopFor === role
          ? '{"tool_calls": [{"toolName": "test_tool", "toolArgs": {}}]}'
          : `{"answer": "${role} finished"}`;

        return {
          model: 'test-slm',
          provider: 'ollama',
          tier: ModelTier.SLM,
          content,
          tokenUsage: { promptTokens: Math.floor(total / 2), completionTokens: Math.ceil(total / 2), totalTokens: total },
          latencyMs: 1,
          costUsd: 0.0001,
          finishReason: 'stop',
        };
      }),
      chatStream: vi.fn(),
    },
  };
}

const routing: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], mid: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
  unifiedPlanning: false,
};

const agent = (role: string): AgentDefinition => ({
  id: role.toLowerCase(),
  role,
  instructions: `You are the ${role}. Do your part.`,
  allowedTools: ['test_tool'],
  executionMode: 'direct',
  maxIterations: 6,
  maxRetries: 0,
});

const modelCallsOf = (r: AgentResult): number => r.taskResult.lifecycleMetrics?.modelCalls ?? 0;

describe('sequential crew: one agent fails', () => {
  let budget: BudgetManager;
  let tracer: TraceLogger;
  let tools: ToolRegistry;

  beforeEach(() => {
    budget = new BudgetManager();
    tracer = new TraceLogger();
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.any(),
      execute: async () => ({ ok: true }),
    }, 'builtin');
  });

  async function runCrew(script: ProviderScript, width = 4) {
    const { provider, calls } = createMockProvider(script);
    const providers = new ModelProviderRegistry();
    providers.register(provider as never);
    const router = new ModelRouter(providers, budget, routing);
    const planner = new Planner(router, tools, providers, budget, tracer);
    const orchestrator = new CrewOrchestrator(planner, budget, router, tracer, tools, providers, undefined, undefined, routing);

    const crew: CrewDefinition = {
      name: `cascade-${width}`,
      strategy: 'sequential',
      agents: ROLES.slice(0, width).map(agent),
      budget: 'high',
      aggregation: 'last',
    };

    const ceilings: number[] = [];
    const sub = budget.createSubEnvelope.bind(budget);
    vi.spyOn(budget, 'createSubEnvelope').mockImplementation((p, s) => {
      const made: BudgetEnvelopeInstance = sub(p, s);
      ceilings.push(made.envelope.maxTokens);
      return made;
    });

    const task: Task = { id: generateId('task'), description: 'Ship the feature', createdAt: new Date().toISOString() };
    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);

    const result = await orchestrator.executeCrew(crew, task, envelope, traceId);
    vi.restoreAllMocks();
    return { result, ceilings, calls };
  }

  /** The first agent burns its whole token ceiling and dies without an answer. */
  const budgetDeath = { loopFor: 'Implementer', tokensPerCall: 20_000 } as const;

  it('runs every later agent when the first one fails', async () => {
    const { result, calls } = await runCrew(budgetDeath);
    const [first, ...rest] = result.agentResults;

    expect(first.taskResult.status).toBe('failed');
    // The contract the sequential loop documents: "Continue pipeline even on
    // failure — downstream agents may still succeed".
    for (const later of rest) {
      expect(later.taskResult.status).toBe('completed');
      expect(modelCallsOf(later)).toBeGreaterThan(0);
    }
    expect(calls).toEqual(['Implementer', 'Implementer', 'Reviewer', 'Tester', 'Researcher']);
  });

  it('keeps the failure visible rather than absorbing it', async () => {
    const { result } = await runCrew(budgetDeath);

    expect(result.agentResults[0].taskResult.error).toBe('Budget exhausted during direct execution');
    // The blackboard says the implementer failed, so later agents are told.
    expect(result.blackboard.entries['implementer']).toMatchObject({ status: 'failed' });
    expect(result.status).toBe('partial');
  });

  it('reports the same shape when the provider throws instead', async () => {
    const { result, calls } = await runCrew({ throwFor: 'Implementer' });

    expect(result.agentResults[0].taskResult.status).toBe('failed');
    expect(result.agentResults[0].taskResult.error).toContain('Provider refused the call');
    // It reached the model — the call itself is what failed.
    expect(modelCallsOf(result.agentResults[0])).toBe(1);
    for (const later of result.agentResults.slice(1)) {
      expect(modelCallsOf(later)).toBeGreaterThan(0);
    }
    expect(calls.filter(c => c !== 'Implementer')).toEqual(['Reviewer', 'Tester', 'Researcher']);
  });

  it('gives a diagnostic that says what each agent did', async () => {
    const { result, ceilings } = await runCrew(budgetDeath);
    const diagnostic = renderCrewDiagnostic(result.agentResults);

    // Printed so a local repro is readable without a debugger.
    // eslint-disable-next-line no-console
    console.log('\n' + diagnostic + `\n\nceilings: ${ceilings.join(', ')}`);

    expect(diagnostic).toContain('Agent 1 / Implementer');
    expect(diagnostic).toContain('status:      failed');
    expect(diagnostic).toContain('error:       Budget exhausted during direct execution');
    expect(diagnostic).toContain('Agent 2 / Reviewer');
    expect(diagnostic).toMatch(/Agent 2 \/ Reviewer[\s\S]*modelCalls:  [1-9]/);
  });
});
