import { describe, it, expect } from 'vitest';
import { ModelTier, PlanValidationError, BUDGET_PRESETS, generateId } from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import { Planner, type ExecutionPlan } from '../src/planner.js';
import { ModelRouter } from '../src/model-router.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { z } from 'zod';

// ─── detectActionIntent unit tests ───

describe('Planner.detectActionIntent', () => {
  it('detects browser navigation intent', () => {
    expect(Planner.detectActionIntent('Open YouTube and play a song')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Navigate to the google website')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Browse to https://example.com')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Visit the YouTube page')).toBeGreaterThanOrEqual(0.7);
  });

  it('detects play/media intent', () => {
    expect(Planner.detectActionIntent('Play the song Tere Bina on YouTube')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Watch a video about cooking')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Stream music from YouTube')).toBeGreaterThanOrEqual(0.7);
  });

  it('detects file operation intent', () => {
    expect(Planner.detectActionIntent('Create a file on the desktop')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Write a text file with my notes')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Save the document to my folder')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Read the file at /tmp/log.txt')).toBeGreaterThanOrEqual(0.7);
  });

  it('detects shell/command intent', () => {
    expect(Planner.detectActionIntent('Run the build command')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Execute the deploy script')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Launch the application')).toBeGreaterThanOrEqual(0.7);
  });

  it('detects network/API intent', () => {
    expect(Planner.detectActionIntent('Fetch data from the API endpoint')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Send a message via webhook')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Post a request to the server')).toBeGreaterThanOrEqual(0.7);
  });

  it('detects IoT/device intent', () => {
    expect(Planner.detectActionIntent('Turn on the living room light')).toBeGreaterThanOrEqual(0.7);
    expect(Planner.detectActionIntent('Set the thermostat to 72 degrees')).toBeGreaterThanOrEqual(0.7);
  });

  it('detects desktop path references', () => {
    expect(Planner.detectActionIntent('Put this on my desktop')).toBeGreaterThanOrEqual(0.7);
  });

  it('returns 0 for pure knowledge questions', () => {
    expect(Planner.detectActionIntent('What is 2 + 2?')).toBe(0);
    expect(Planner.detectActionIntent('Who is the president of France?')).toBe(0);
    expect(Planner.detectActionIntent('Hello, how are you?')).toBe(0);
    expect(Planner.detectActionIntent('Explain quantum physics')).toBe(0);
    expect(Planner.detectActionIntent('What is the meaning of life?')).toBe(0);
  });
});

function createMockProviderWithResponses(responses: string[]) {
  let callIdx = 0;
  return {
    name: 'mock',
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: async () => true,
    listModels: async () => [
      { id: 'mock-slm', name: 'Mock SLM', tier: ModelTier.SLM, contextWindow: 4096, maxOutputTokens: 2048 },
      { id: 'mock-llm', name: 'Mock LLM', tier: ModelTier.LLM, contextWindow: 8192, maxOutputTokens: 4096 },
    ],
    estimateCost: () => 0.001,
    chat: async () => {
      const content = responses[callIdx] ?? '{}';
      callIdx++;
      return {
        content,
        model: 'mock-slm',
        tokenUsage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
        costUsd: 0.001,
        latencyMs: 100,
      };
    },
    chatStream: async function* () {
      yield { content: 'test', done: false };
      yield { content: '', done: true, tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    },
  };
}

function createTestTracer(): { tracer: TraceLogger; traceId: string } {
  const tracer = new TraceLogger();
  const traceId = generateId('trace');
  tracer.createTrace(traceId, 'test-task', BUDGET_PRESETS.medium);
  return { tracer, traceId };
}

describe('Planner', () => {
  let planner: Planner;
  let budgetManager: BudgetManager;
  let tracer: TraceLogger;
  let traceId: string;

  function setup(responses: string[]) {
    const registry = new ModelProviderRegistry();
    registry.register(createMockProviderWithResponses(responses) as any);

    budgetManager = new BudgetManager();
    const t = createTestTracer();
    tracer = t.tracer;
    traceId = t.traceId;

    const router = new ModelRouter(registry, budgetManager, {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: ['mock'], llm: ['mock'] },
    });

    const tools = new ToolRegistry();
    tools.register({
      name: 'file_read',
      description: 'Read a file',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({}).passthrough(),
      execute: async () => ({}),
      tags: [],
      source: 'builtin',
    });
    tools.register({
      name: 'shell_exec',
      description: 'Execute a shell command',
      inputSchema: z.object({ command: z.string() }),
      outputSchema: z.object({}).passthrough(),
      execute: async () => ({}),
      tags: [],
      source: 'builtin',
    });

    planner = new Planner(router, tools, registry, budgetManager, tracer);
  }

  it('classifies task complexity', async () => {
    setup([JSON.stringify({ complexity: 0.3, reason: 'Simple lookup' })]);
    const envelope = budgetManager.createEnvelope('medium');
    const complexity = await planner.classifyComplexity(
      { id: 'task_1', description: 'What is 2+2?', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );
    expect(complexity).toBeCloseTo(0.3, 1);
  });

  it('boosts complexity for action tasks even when SLM scores low', async () => {
    // SLM says 0.2 but task clearly requires browser action
    setup([JSON.stringify({ complexity: 0.2, reason: 'Simple request' })]);
    const envelope = budgetManager.createEnvelope('medium');
    const complexity = await planner.classifyComplexity(
      { id: 'task_1', description: 'Open YouTube and play a song', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );
    // Should be boosted to at least 0.7 by action detection
    expect(complexity).toBeGreaterThanOrEqual(0.7);
  });

  it('does not boost complexity for pure knowledge tasks', async () => {
    setup([JSON.stringify({ complexity: 0.2, reason: 'Simple math' })]);
    const envelope = budgetManager.createEnvelope('medium');
    const complexity = await planner.classifyComplexity(
      { id: 'task_1', description: 'What is the capital of France?', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );
    // No action keywords — stays at SLM score
    expect(complexity).toBeCloseTo(0.2, 1);
  });

  it('defaults to 0.5 on parse failure', async () => {
    setup(['not valid json']);
    const envelope = budgetManager.createEnvelope('medium');
    const complexity = await planner.classifyComplexity(
      { id: 'task_1', description: 'test', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );
    expect(complexity).toBe(0.5);
  });

  it('generates a plan from model response', async () => {
    const planResponse = JSON.stringify({
      steps: [
        { description: 'Read the file', toolName: 'file_read', toolArgs: { path: '/tmp/test.txt' } },
        { description: 'Run a command', toolName: 'shell_exec', toolArgs: { command: 'echo hello' } },
      ],
    });

    setup([
      JSON.stringify({ complexity: 0.5, reason: 'Multi-step' }),
      planResponse,
    ]);

    const envelope = budgetManager.createEnvelope('medium');

    await planner.classifyComplexity(
      { id: 'task_1', description: 'Read a file and run a command', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );

    const plan = await planner.plan(
      { id: 'task_1', description: 'Read a file and run a command', budget: 'medium', createdAt: new Date().toISOString() },
      0.5,
      envelope,
      traceId,
    );

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].toolName).toBe('file_read');
    expect(plan.steps[1].toolName).toBe('shell_exec');
  });

  it('validates plan with known tools', async () => {
    setup([]);
    const plan: ExecutionPlan = {
      taskId: 'task_1',
      complexity: 0.5,
      steps: [
        { index: 0, description: 'Read', toolName: 'file_read', toolArgs: {} },
      ],
    };
    expect(() => planner.validatePlan(plan)).not.toThrow();
  });

  it('rejects plan with unknown tools', async () => {
    setup([]);
    const plan: ExecutionPlan = {
      taskId: 'task_1',
      complexity: 0.5,
      steps: [
        { index: 0, description: 'Unknown', toolName: 'does_not_exist', toolArgs: {} },
      ],
    };
    expect(() => planner.validatePlan(plan)).toThrow(PlanValidationError);
  });

  it('allows empty plans for direct-answer tasks', async () => {
    setup([]);
    const plan: ExecutionPlan = {
      taskId: 'task_1',
      complexity: 0.5,
      steps: [],
    };
    // Empty plans are valid — synthesis handles direct answers
    expect(() => planner.validatePlan(plan)).not.toThrow();
  });

  it('throws on unparseable plan response', async () => {
    setup([
      JSON.stringify({ complexity: 0.5 }),
      'This is not JSON at all',
    ]);

    const envelope = budgetManager.createEnvelope('medium');

    await planner.classifyComplexity(
      { id: 'task_1', description: 'test', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );

    await expect(
      planner.plan(
        { id: 'task_1', description: 'test', budget: 'medium', createdAt: new Date().toISOString() },
        0.5,
        envelope,
        traceId,
      ),
    ).rejects.toThrow(PlanValidationError);
  });

  it('escalates to LLM when SLM returns empty plan for action task', async () => {
    setup([
      // classify → SLM says 0.8
      JSON.stringify({ complexity: 0.8, reason: 'Action task' }),
      // plan (SLM) → empty steps
      JSON.stringify({ steps: [] }),
      // plan escalation (LLM) → proper steps
      JSON.stringify({
        steps: [
          { description: 'Read the config file', toolName: 'file_read', toolArgs: { path: '/etc/config' } },
        ],
      }),
    ]);

    const envelope = budgetManager.createEnvelope('high');

    await planner.classifyComplexity(
      { id: 'task_1', description: 'Read the config file from the system', budget: 'high', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );

    const plan = await planner.plan(
      { id: 'task_1', description: 'Read the config file from the system', budget: 'high', createdAt: new Date().toISOString() },
      0.8,
      envelope,
      traceId,
    );

    // Should have escalated and gotten the LLM's plan with actual steps
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0].toolName).toBe('file_read');
  });

  it('does not escalate for pure knowledge tasks with empty plans', async () => {
    setup([
      // classify
      JSON.stringify({ complexity: 0.2, reason: 'Simple question' }),
      // plan → empty steps (correct for knowledge questions)
      JSON.stringify({ steps: [] }),
    ]);

    const envelope = budgetManager.createEnvelope('medium');

    await planner.classifyComplexity(
      { id: 'task_1', description: 'What is 2+2?', budget: 'medium', createdAt: new Date().toISOString() },
      envelope,
      traceId,
    );

    const plan = await planner.plan(
      { id: 'task_1', description: 'What is 2+2?', budget: 'medium', createdAt: new Date().toISOString() },
      0.2,
      envelope,
      traceId,
    );

    // No escalation — empty plan is correct for knowledge questions
    expect(plan.steps).toHaveLength(0);
  });
});
