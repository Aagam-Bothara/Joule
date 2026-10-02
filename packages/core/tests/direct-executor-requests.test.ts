/**
 * Golden: the exact ModelRequest sequence of a scripted multi-turn direct run.
 *
 * Token usage is recorded from each response (prompt, completion and cached
 * prompt tokens). Recording is measurement only, so it must not change any
 * request the model is sent. The fixture was captured from the executor
 * before token recording existed (2026-10-02, at commit ff01479) and is
 * compared field by field.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DirectExecutor } from '../src/direct-executor.js';
import { BudgetManager } from '../src/budget-manager.js';
import { ModelRouter } from '../src/model-router.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier } from '@joule/shared';
import type { AgentDefinition, ModelRequest, RoutingConfig, Task } from '@joule/shared';

const REPLIES = [
  '{"tool_calls": [{"toolName": "lookup", "toolArgs": {"query": "alpha"}}]}',
  'this is not a tool call {"tool_calls": [',
  '{"tool_calls": [{"toolName": "lookup", "toolArgs": {"query": "beta"}}, {"toolName": "lookup", "toolArgs": {"query": "gamma"}}]}',
  '',
  '{"tool_calls": [{"toolName": "lookup", "toolArgs": {"query": "gamma"}}]}',
  '{"answer": "alpha, beta and gamma looked up"}',
];

/** Usage per reply: some report cached prompt tokens, some (like openai.ts when 0) omit the field. */
const USAGE = [
  { promptTokens: 1200, completionTokens: 40, totalTokens: 1240 },
  { promptTokens: 1300, completionTokens: 15, totalTokens: 1315, cachedPromptTokens: 1024 },
  { promptTokens: 1400, completionTokens: 60, totalTokens: 1460, cachedPromptTokens: 1152 },
  { promptTokens: 1500, completionTokens: 0, totalTokens: 1500 },
  { promptTokens: 1600, completionTokens: 30, totalTokens: 1630, cachedPromptTokens: 1280 },
  { promptTokens: 1700, completionTokens: 20, totalTokens: 1720 },
];

const routing: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
  unifiedPlanning: false,
};

async function scriptedRun() {
  const requests: ModelRequest[] = [];
  let call = 0;
  const provider = {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([
      { id: 'test-slm', name: 'Test SLM', tier: ModelTier.SLM, provider: 'ollama' },
      { id: 'test-llm', name: 'Test LLM', tier: ModelTier.LLM, provider: 'ollama' },
    ]),
    estimateCost: vi.fn().mockReturnValue(0.001),
    chat: vi.fn().mockImplementation(async (request: ModelRequest) => {
      // A deep copy at call time: the executor keeps appending to its history.
      requests.push(JSON.parse(JSON.stringify(request)) as ModelRequest);
      const i = Math.min(call, REPLIES.length - 1);
      call++;
      return {
        model: 'test-slm', provider: 'ollama', tier: ModelTier.SLM,
        content: REPLIES[i], tokenUsage: USAGE[i], latencyMs: 5, costUsd: 0.001, finishReason: 'stop' as const,
      };
    }),
    chatStream: vi.fn(),
  };
  const registry = new ModelProviderRegistry();
  registry.register(provider);
  const budget = new BudgetManager();
  const router = new ModelRouter(registry, budget, routing);
  const tools = new ToolRegistry();
  tools.register({
    name: 'lookup',
    description: 'Look a word up',
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.any(),
    execute: async (input: { query: string }) => ({ found: input.query.toUpperCase() }),
  }, 'builtin');
  const executor = new DirectExecutor(budget, router, tools, registry);
  const envelope = budget.createEnvelope({ maxTokens: 100_000, costCeilingUsd: 10, maxLatencyMs: 300_000, maxToolCalls: 50, maxEscalations: 5 });
  const task: Task = { id: 'task-golden', description: 'Look up alpha, beta and gamma, then say which you looked up.', createdAt: '2026-10-02T00:00:00.000Z' };
  const agent: AgentDefinition = { id: 'golden', role: 'tester', instructions: 'You look things up.', allowedTools: ['lookup'], maxIterations: 10 };
  const result = await executor.execute(task, envelope, agent);
  return { requests, result };
}

describe('direct executor model requests (golden)', () => {
  it('sends exactly the pinned request sequence for a scripted multi-turn run', async () => {
    const { requests, result } = await scriptedRun();
    const pinned = JSON.parse(readFileSync(new URL('./fixtures/direct-executor-requests.json', import.meta.url), 'utf8')) as ModelRequest[];
    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(pinned.length);
    for (let i = 0; i < pinned.length; i++) expect(requests[i]).toEqual(pinned[i]);
    // Field sets too, so an added request field (even an undefined one) shows.
    expect(requests.map(r => Object.keys(r).sort())).toEqual(pinned.map(r => Object.keys(r).sort()));
  });

  it('records prompt, completion and cached prompt tokens summed over the calls', async () => {
    const { result } = await scriptedRun();
    const sum = (k: 'promptTokens' | 'completionTokens' | 'totalTokens') => USAGE.reduce((s, u) => s + u[k], 0);
    expect(result.budgetUsed.tokensUsed).toBe(sum('totalTokens'));
    expect(result.promptTokens).toBe(sum('promptTokens'));
    expect(result.completionTokens).toBe(sum('completionTokens'));
    expect(result.cachedPromptTokens).toBe(1024 + 1152 + 1280);
  });
});
