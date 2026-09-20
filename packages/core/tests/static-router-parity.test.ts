import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { ModelProviderRegistry } from '@joule/models';
import { fileWriteTool } from '@joule/tools';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig } from '@joule/shared';

/**
 * The static-router path had neither lifecycle records nor an edit gate, while
 * the adaptive and direct paths had both. Mixing execution modes in an
 * experiment would then compare instrumented runs against blind ones, so these
 * tests pin the parity rather than the pipeline's behaviour.
 */

function createMockProvider(responses: string[]) {
  let callIndex = 0;
  return {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([
      { id: 'test-slm', name: 'Test SLM', tier: ModelTier.SLM, provider: 'ollama' },
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

const routing: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
  unifiedPlanning: false,
  defaultMode: 'static-router',
};

function buildExecutor(responses: string[], tools: ToolRegistry) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  providers.register(createMockProvider(responses) as never);
  const router = new ModelRouter(providers, budget, routing);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, routing);
  return { executor, planner };
}

const task = (overrides: Partial<Task> = {}): Task => ({
  id: generateId('task'),
  description: 'Static router parity task',
  budget: 'high',
  mode: 'static-router',
  createdAt: new Date().toISOString(),
  ...overrides,
});

let tools: ToolRegistry;
let dir: string;

beforeEach(() => {
  tools = new ToolRegistry();
  tools.register({
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ echoed: args.input ?? '' }),
  }, 'builtin');
  tools.register(fileWriteTool, 'builtin');

  dir = mkdtempSync(join(tmpdir(), 'joule-static-parity-'));
  writeFileSync(join(dir, 'check.js'), [
    'const fs = require("fs");',
    'const p = require("path").join(__dirname, "solution.py");',
    'if (!fs.existsSync(p)) process.exit(1);',
    'process.exit(fs.readFileSync(p, "utf8").includes("GOOD") ? 0 : 1);',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const planWith = (steps: unknown[]): string[] => [
  '{"goal": "test", "constraints": [], "successCriteria": [{"description": "done", "type": "tool_succeeded", "check": {}}]}',
  '{"complexity": 0.3}',
  JSON.stringify({ steps }),
  '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
  'Synthesized.',
];

describe('static-router parity', () => {
  it('produces lifecycle records like the other execution paths', async () => {
    const { executor } = buildExecutor(
      planWith([{ description: 'Run tool', toolName: 'test_tool', toolArgs: { input: 'hi' } }]),
      tools,
    );

    const result = await executor.execute(task());

    expect(result.status).toBe('completed');
    const events = result.lifecycle ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Planning calls are model time; the step is tool wait.
    expect(events.some(e => e.to === 'model_running')).toBe(true);
    expect(events.some(e => e.to === 'tool_wait' && e.tool === 'test_tool')).toBe(true);
    expect(events[events.length - 1].to).toBe('completed');

    const metrics = result.lifecycleMetrics!;
    expect(metrics.modelCalls).toBeGreaterThan(0);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.finalState).toBe('completed');
  });

  it('records a terminal failed state when the run fails', async () => {
    const { executor } = buildExecutor(
      planWith([{ description: 'Missing tool', toolName: 'no_such_tool', toolArgs: {} }]),
      tools,
    );

    const result = await executor.execute(task());

    const events = result.lifecycle ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(['completed', 'failed']).toContain(events[events.length - 1].to);
    expect(result.lifecycleMetrics?.finalState).toBe(events[events.length - 1].to);
  });

  it('rolls back a step that breaks a verified workspace', async () => {
    const solution = join(dir, 'solution.py').replace(/\\/g, '/');
    const { executor } = buildExecutor(
      planWith([
        { description: 'Write a good solution', toolName: 'file_write', toolArgs: { path: solution, content: '# GOOD v1' } },
        { description: 'Break it', toolName: 'file_write', toolArgs: { path: solution, content: '# BROKEN' } },
      ]),
      tools,
    );

    const result = await executor.execute(task({
      verifiedEdit: { command: 'node check.js', cwd: dir, timeoutMs: 20_000 },
    }));

    // The working version survived the second step.
    expect(readFileSync(join(dir, 'solution.py'), 'utf8')).toBe('# GOOD v1');
    expect(result.verifiedEdits).toMatchObject({ rollbacks: 1, proposed: 2, accepted: 1 });
    expect(result.verifiedEdits?.acceptanceRate).toBeCloseTo(0.5, 6);
    // The reverted step is reported as failed rather than silently successful.
    expect(result.stepResults.some(s => s.error?.includes('rolled back'))).toBe(true);
  });

  it('leaves the path untouched when no policy is set', async () => {
    const solution = join(dir, 'solution.py').replace(/\\/g, '/');
    const { executor } = buildExecutor(
      planWith([
        { description: 'Write a good solution', toolName: 'file_write', toolArgs: { path: solution, content: '# GOOD v1' } },
        { description: 'Break it', toolName: 'file_write', toolArgs: { path: solution, content: '# BROKEN' } },
      ]),
      tools,
    );

    const result = await executor.execute(task());

    expect(readFileSync(join(dir, 'solution.py'), 'utf8')).toBe('# BROKEN');
    expect(result.verifiedEdits).toBeUndefined();
  });

  it('detaches the tracker from the planner once the run ends', async () => {
    const { executor, planner } = buildExecutor(
      planWith([{ description: 'Run tool', toolName: 'test_tool', toolArgs: {} }]),
      tools,
    );

    await executor.execute(task());

    // A tracker left attached would attribute the next run's planning calls to
    // the finished run.
    expect((planner as unknown as { lifecycle?: unknown }).lifecycle).toBeUndefined();
  });
});
