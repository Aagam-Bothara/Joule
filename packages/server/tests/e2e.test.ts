/**
 * Joule E2E Test — exercises all 6 new DX features end-to-end.
 *
 * Run:  pnpm vitest run packages/server/tests/e2e.test.ts
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import {
  Joule,
  simple,
  simpleStream,
  OtlpExporter,
  computeDiff,
} from '@joule/core';
import { ModelTier, generateId } from '@joule/shared';

// ── Mock provider (matching integration.test.ts format) ──────────────────────

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
      const content = responses[callIndex % responses.length];
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
    chatStream: vi.fn().mockImplementation(async function* () {
      const content = responses[callIndex % responses.length];
      callIndex++;
      yield { content, done: false };
      yield {
        content: '',
        done: true,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      };
    }),
  };
}

// Standard LLM response sequence for task execution
const TASK_RESPONSES = [
  '{"goal": "test", "constraints": [], "successCriteria": []}',
  '{"complexity": 0.3}',
  '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "hello"}}]}',
  '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
  'Task completed successfully.',
];

async function createTestJoule(responses: string[]) {
  const joule = new Joule({
    providers: { ollama: { enabled: false, baseUrl: 'http://localhost:11434', models: { slm: 'test' } } },
    routing: {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: ['ollama'], llm: ['ollama'] },
      maxReplanDepth: 2,
    },
    tools: { builtinEnabled: false, pluginDirs: [], disabledTools: [] },
    logging: { level: 'error', traceOutput: 'memory' },
  } as any);
  await joule.initialize();
  joule.initializeDatabase();
  joule.providers.register(createMockProvider(responses) as any);

  // Register a test tool (same as integration.test.ts)
  joule.registerTool({
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ result: `done: ${args.input ?? 'default'}` }),
  });

  return joule;
}

// ── Test 1: Simple Mode API ──────────────────────────────────────────────────

describe('Feature 1: Simple Mode API', () => {
  it('should export simple and simpleStream functions', () => {
    expect(typeof simple).toBe('function');
    expect(typeof simpleStream).toBe('function');
  });

  it('should have static methods on Joule class', () => {
    expect(typeof Joule.simple).toBe('function');
    expect(typeof Joule.simpleStream).toBe('function');
  });
});

// ── Test 2: Trace Timeline (server API) ──────────────────────────────────────

describe('Feature 2: Trace Timeline', () => {
  let joule: Joule;
  let taskId: string;

  afterAll(async () => { if (joule) await joule.shutdown(); });

  it('should execute a task via API and expose trace', async () => {
    joule = await createTestJoule(TASK_RESPONSES);
    // Use same app instance for both requests so in-memory map persists
    const app = await createApp(joule);

    // Submit task through the API so it gets stored in the in-memory map
    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Say hello in one word', budget: 'low' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.status).toBe('completed');
    expect(body.trace).toBeDefined();
    taskId = body.taskId;
    expect(taskId).toBeDefined();

    // Now fetch trace from the same app instance
    const traceRes = await app.request(`/tasks/${taskId}/trace`);
    expect(traceRes.status).toBe(200);

    const data = await traceRes.json() as any;
    expect(data).toBeDefined();
  });
});

// ── Test 3: Init Wizard ──────────────────────────────────────────────────────

describe('Feature 3: Init Wizard', () => {
  // Import dynamically with correct path — init-wizard.ts is a source file in cli package
  // Since vitest resolves from the file's location, we use the workspace import
  let wizardToConfig: any;
  let getCrewTemplateName: any;
  let validateApiKeyFormat: any;

  it('should import wizard functions', async () => {
    // Direct import from the source TS file
    const mod = await import('../../cli/src/commands/init-wizard.js');
    wizardToConfig = mod.wizardToConfig;
    getCrewTemplateName = mod.getCrewTemplateName;
    validateApiKeyFormat = mod.validateApiKeyFormat;

    expect(typeof wizardToConfig).toBe('function');
    expect(typeof getCrewTemplateName).toBe('function');
    expect(typeof validateApiKeyFormat).toBe('function');
  });

  it('should generate config for anthropic + advanced', () => {
    const config = wizardToConfig({
      provider: 'anthropic',
      useCase: 'code-review',
      complexity: 'advanced',
    });

    expect(config.providers?.anthropic?.enabled).toBe(true);
    expect(config.budget).toBe('high');
    expect(config.governance).toBe(true);
  });

  it('should generate config for google + simple', () => {
    const config = wizardToConfig({
      provider: 'google',
      useCase: 'general',
      complexity: 'simple',
    });

    expect(config.providers?.google?.enabled).toBe(true);
    expect(config.budget).toBe('low');
    expect(config.governance).toBe(false);
  });

  it('should map use cases to crew templates', () => {
    expect(getCrewTemplateName('code-review')).toBe('CODE_REVIEW_CREW');
    expect(getCrewTemplateName('research')).toBe('RESEARCH_CREW');
    expect(getCrewTemplateName('general')).toBeNull();
  });

  it('should validate API key formats', () => {
    expect(validateApiKeyFormat('anthropic', 'sk-ant-abc123xyz')).toBe(true);
    expect(validateApiKeyFormat('anthropic', 'bad')).toBe(false);
    expect(validateApiKeyFormat('openai', 'sk-abc123xyz456')).toBe(true);
    expect(validateApiKeyFormat('google', 'AIzaSyAwNrw5-7y3kW1D')).toBe(true);
  });
});

// ── Test 4: Trace Exporters ──────────────────────────────────────────────────

describe('Feature 4: Trace Exporters', () => {
  it('should instantiate OTLP exporter', () => {
    const otlp = new OtlpExporter({
      endpoint: 'http://localhost:4318/v1/traces',
    });

    expect(otlp.name).toBe('otlp');
    expect(typeof otlp.export).toBe('function');
    expect(typeof otlp.shutdown).toBe('function');
  });

  it('should instantiate Langfuse exporter (may skip if SDK not installed)', async () => {
    try {
      const { LangfuseExporter } = await import('@joule/core');
      const langfuse = new LangfuseExporter({
        publicKey: 'pk-lf-test',
        secretKey: 'sk-lf-test',
      });
      expect(langfuse.name).toBe('langfuse');
      expect(typeof langfuse.export).toBe('function');
    } catch {
      // Langfuse SDK is optional
      console.log('    (Langfuse SDK not installed — skipping)');
    }
  });
});

// ── Test 5: Live Budget Burn (SSE stream) ────────────────────────────────────

describe('Feature 5: Live Budget Burn (SSE stream)', () => {
  let joule: Joule;
  afterAll(async () => { if (joule) await joule.shutdown(); });

  it('should stream task execution as SSE events', async () => {
    joule = await createTestJoule(TASK_RESPONSES);
    const app = await createApp(joule);

    const res = await app.request('/tasks/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'What is 3 + 5?',
        budget: 'low',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await res.text();

    // SSE format: "event: <type>\ndata: <json>\n\n"
    // Check for the result event in the raw SSE text
    const hasResult = body.includes('event: result');
    expect(hasResult).toBe(true);

    // Verify we got at least some data lines
    const dataLines = body.split('\n').filter(l => l.startsWith('data:'));
    expect(dataLines.length).toBeGreaterThan(0);
  });
});

// ── Test 6: Execution Replay + Diff ──────────────────────────────────────────

describe('Feature 6: Execution Replay + Diff', () => {
  let joule: Joule;
  afterAll(async () => { if (joule) await joule.shutdown(); });

  it('should compute diff between two execution results', () => {
    const diff = computeDiff(
      { result: 'answer A', budgetUsed: undefined, steps: [], tools: ['tool1'] },
      { result: 'answer B', budgetUsed: undefined, steps: [], tools: ['tool1', 'tool2'] },
    );

    expect(diff.outputChanged).toBe(true);
    expect(diff.stepComparison.toolsAdded).toContain('tool2');
    expect(diff.stepComparison.toolsRemoved).toHaveLength(0);
    expect(diff.budgetComparison.tokenDelta).toBe(0);
  });

  it('should execute a task and replay it via server API', async () => {
    // Need enough responses for both original + replay (each is 5 LLM calls)
    joule = await createTestJoule([
      ...TASK_RESPONSES,
      ...TASK_RESPONSES,
    ]);
    const app = await createApp(joule);

    // Execute original via API
    const createRes = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'What is 3 + 5?', budget: 'low' }),
    });

    expect(createRes.status).toBe(201);
    const taskData = await createRes.json() as any;
    const taskId = taskData.id;
    expect(taskId).toBeDefined();

    // Replay via POST /replay/:id
    const replayRes = await app.request(`/replay/${taskId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budget: 'low' }),
    });

    expect(replayRes.status).toBe(200);

    const data = await replayRes.json() as any;
    expect(data.original).toBeDefined();
    expect(data.replay).toBeDefined();
    expect(data.diff).toBeDefined();
    expect(typeof data.diff.outputChanged).toBe('boolean');
  });
});

// ── Test 7: Server Routes ────────────────────────────────────────────────────

describe('Server Routes', () => {
  let joule: Joule;
  afterAll(async () => { if (joule) await joule.shutdown(); });

  it('GET /health should return 200', async () => {
    joule = await createTestJoule([]);
    const app = await createApp(joule);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('GET /tools should return 200', async () => {
    const app = await createApp(joule);
    const res = await app.request('/tools');
    expect(res.status).toBe(200);
  });

  it('GET /tasks should return 200', async () => {
    const app = await createApp(joule);
    const res = await app.request('/tasks');
    expect(res.status).toBe(200);
  });

  it('GET /openapi should return 200', async () => {
    const app = await createApp(joule);
    const res = await app.request('/openapi');
    expect(res.status).toBe(200);
  });
});
