import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { Joule } from '@joule/core';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';

// Mock provider for integration tests
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
    chatStream: vi.fn().mockImplementation(async function* () {
      const content = responses[callIndex] ?? '{}';
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

async function createTestJoule(responses: string[], authEnabled = false) {
  const joule = new Joule({
    providers: { ollama: { enabled: false, baseUrl: 'http://localhost:11434', models: { slm: 'test' } } },
    routing: {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: ['ollama'], llm: ['ollama'] },
      maxReplanDepth: 2,
    },
    ...(authEnabled ? {
      auth: {
        enabled: true,
        jwtSecret: 'test-secret-key-for-integration-tests',
        tokenExpirySeconds: 3600,
        allowRegistration: true,
      },
    } : {}),
  });
  await joule.initialize();

  // Register mock provider
  const mockProvider = createMockProvider(responses);
  joule.providers.register(mockProvider as any);

  // Register a test tool
  joule.registerTool({
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ result: `done: ${args.input ?? 'default'}` }),
  });

  return joule;
}

describe('Server Integration: Task Routes', () => {
  it('POST /tasks should execute and return result', async () => {
    const joule = await createTestJoule([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "api"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Task completed via API.',
    ]);
    const app = await createApp(joule);

    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Test task via API' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.stepResults).toHaveLength(1);
    expect(body.result).toBeTruthy();
    expect(body.taskId).toBeTruthy();
    expect(body.budgetUsed).toBeDefined();
  });

  it('GET /tasks should list submitted tasks', async () => {
    const joule = await createTestJoule([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "S", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done 1.',
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "S", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done 2.',
    ]);
    const app = await createApp(joule);

    // Submit 2 tasks
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Task 1' }),
    });
    await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Task 2' }),
    });

    const res = await app.request('/tasks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].status).toBe('completed');
  });

  it('GET /tasks/:id should return a specific task', async () => {
    const joule = await createTestJoule([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "S", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ]);
    const app = await createApp(joule);

    const submitRes = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Fetch me' }),
    });
    const submitted = await submitRes.json();

    const res = await app.request(`/tasks/${submitted.taskId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskId).toBe(submitted.taskId);
  });

  it('GET /tasks/:id should return 404 for nonexistent task', async () => {
    const joule = await createTestJoule([]);
    const app = await createApp(joule);

    const res = await app.request('/tasks/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('GET /tasks/:id/trace should return execution trace', async () => {
    const joule = await createTestJoule([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "S", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ]);
    const app = await createApp(joule);

    const submitRes = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Trace me' }),
    });
    const submitted = await submitRes.json();

    const res = await app.request(`/tasks/${submitted.taskId}/trace`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spans).toBeDefined();
    expect(Array.isArray(body.spans)).toBe(true);
  });

  it('POST /tasks should return 400 for invalid input', async () => {
    const joule = await createTestJoule([]);
    const app = await createApp(joule);

    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // Missing description
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe('Server Integration: Health', () => {
  it('GET /health should return server status', async () => {
    const joule = await createTestJoule([]);
    const app = await createApp(joule);

    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.providers).toBeDefined();
    expect(body.tools).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.config).toBeDefined();
  });
});

describe('Server Integration: Tools', () => {
  it('GET /tools should list registered tools', async () => {
    const joule = await createTestJoule([]);
    const app = await createApp(joule);

    const res = await app.request('/tools');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.some((t: any) => t.name === 'test_tool')).toBe(true);
  });
});

describe('Server Integration: Auth Flow', () => {
  let tempDir: string;
  let origCwd: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-server-auth-'));
    origCwd = process.cwd();
    process.chdir(tempDir);
    // Create .joule directory for user store
    await fs.mkdir(path.join(tempDir, '.joule'), { recursive: true });
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should register, login, and access protected routes', async () => {
    const joule = await createTestJoule([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "S", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Auth test done.',
    ], true);
    const app = await createApp(joule);

    // Register
    const regRes = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testuser', password: 'testpass123' }),
    });
    const regBody = await regRes.json();
    expect(regRes.status).toBe(201);
    expect(regBody.token).toBeTruthy();
    const token = regBody.token;

    // Use token for protected route
    const taskRes = await app.request('/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ description: 'Authenticated task' }),
    });
    expect(taskRes.status).toBe(201);
  });

  it('should reject invalid credentials', async () => {
    const joule = await createTestJoule([], true);
    const app = await createApp(joule);

    // Register first
    await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'pass123' }),
    });

    // Try login with wrong password
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'wrong' }),
    });
    expect(loginRes.status).toBe(401);
  });

  it('should reject requests without auth when auth is enabled', async () => {
    const joule = await createTestJoule([], true);
    const app = await createApp(joule);

    const res = await app.request('/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'No auth' }),
    });
    expect(res.status).toBe(401);
  });
});
