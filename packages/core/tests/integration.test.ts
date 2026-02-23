import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Joule } from '../src/engine.js';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { SessionManager } from '../src/session-manager.js';
import { Scheduler } from '../src/scheduler.js';
import { ConfigManager } from '../src/config-manager.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, StreamEvent } from '@joule/shared';

// Reusable mock provider that returns responses in sequence
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
        energyWh: 0.0001,
      };
    }),
    chatStream: vi.fn().mockImplementation(async function* () {
      const content = responses[callIndex] ?? '{}';
      callIndex++;
      yield { content: content.slice(0, content.length / 2), done: false };
      yield { content: content.slice(content.length / 2), done: false };
      yield {
        content: '',
        done: true,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop',
      };
    }),
  };
}

function createTask(budget?: string): Task {
  return {
    id: generateId('task'),
    description: 'Integration test task',
    budget: (budget ?? 'high') as any,
    createdAt: new Date().toISOString(),
  };
}

const defaultRouting: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
};

function buildExecutor(responses: string[], tools: ToolRegistry) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  const mockProvider = createMockProvider(responses);
  providers.register(mockProvider as any);

  const router = new ModelRouter(providers, budget, defaultRouting);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, { enabled: true, gridCarbonIntensity: 400, localModelCarbonIntensity: 0, includeInRouting: false, energyWeight: 0 }, defaultRouting);

  return { executor, budget, tracer, providers, mockProvider };
}

describe('Integration: Full Pipeline', () => {
  let tools: ToolRegistry;

  beforeEach(() => {
    tools = new ToolRegistry();
    tools.register({
      name: 'test_tool',
      description: 'A simple test tool',
      inputSchema: z.object({ input: z.string().optional() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ result: `processed: ${args.input ?? 'default'}` }),
    }, 'builtin');
  });

  it('should execute a full task pipeline: classify -> plan -> execute -> synthesize', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": [{"description": "done", "type": "tool_succeeded", "check": {}}]}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run test tool", "toolName": "test_tool", "toolArgs": {"input": "hello"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'The test tool returned: processed hello.',
    ], tools);

    const task = createTask();
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].success).toBe(true);
    expect(result.stepResults[0].output).toEqual({ result: 'processed: hello' });
    expect(result.result).toBeTruthy();
    expect(result.trace).toBeDefined();
    expect(result.budgetUsed).toBeDefined();
    expect(result.budgetUsed.tokensUsed).toBeGreaterThan(0);
  });

  it('should handle streaming execution with progress/chunk/result events', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {"input": "stream"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Streamed result.',
    ], tools);

    const task = createTask();
    const events: StreamEvent[] = [];

    for await (const event of executor.executeStream(task)) {
      events.push(event);
    }

    const types = events.map(e => e.type);
    expect(types).toContain('progress');
    expect(types).toContain('result');

    const resultEvent = events.find(e => e.type === 'result');
    expect(resultEvent?.result?.status).toBe('completed');
    expect(resultEvent?.result?.stepResults).toHaveLength(1);
  });

  it('should handle budget exhaustion mid-execution', async () => {
    // Use 'low' budget (4000 tokens max) — after spec + classify + plan consume tokens,
    // the mock provider returns 150 tokens per call, so it should exhaust after a few calls
    const manySteps = Array.from({ length: 30 }, (_, i) =>
      `{"description": "Step ${i}", "toolName": "test_tool", "toolArgs": {"input": "${i}"}}`
    ).join(',');

    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      `{"steps": [${manySteps}]}`,
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Partial result.',
    ], tools);

    const task = createTask('low');
    const result = await executor.execute(task);

    expect(result.status).toBe('budget_exhausted');
    expect(result.budgetUsed.tokensUsed).toBeGreaterThan(0);
  });

  it('should re-plan on step failure', async () => {
    tools.register({
      name: 'failing_tool',
      description: 'A tool that fails',
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.any(),
      execute: async () => { throw new Error('Intentional failure'); },
    }, 'builtin');

    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Fail", "toolName": "failing_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      '{"steps": [{"description": "Recover", "toolName": "test_tool", "toolArgs": {"input": "recovery"}}]}',
      'Recovered successfully.',
    ], tools);

    const task = createTask();
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.stepResults.length).toBeGreaterThanOrEqual(2);
    expect(result.stepResults[0].success).toBe(false);
    expect(result.stepResults.some(s => s.success)).toBe(true);
  });

  it('should execute multi-step plans', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.5}',
      '{"steps": [{"description": "Step 1", "toolName": "test_tool", "toolArgs": {"input": "a"}}, {"description": "Step 2", "toolName": "test_tool", "toolArgs": {"input": "b"}}, {"description": "Step 3", "toolName": "test_tool", "toolArgs": {"input": "c"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8, 0.8, 0.8], "issues": []}',
      'All three steps completed successfully.',
    ], tools);

    const task = createTask();
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.stepResults).toHaveLength(3);
    expect(result.stepResults.every(s => s.success)).toBe(true);
  });

  it('should include energy tracking in results when enabled', async () => {
    const { executor } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Run tool", "toolName": "test_tool", "toolArgs": {}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Done.',
    ], tools);

    const task = createTask();
    const result = await executor.execute(task);

    expect(result.status).toBe('completed');
    expect(result.efficiencyReport).toBeDefined();
    expect(result.budgetUsed.energyWh).toBeGreaterThanOrEqual(0);
  });

  it('should execute multiple tasks independently on same executor', async () => {
    // Need enough responses for 2 tasks: 5 calls each (spec + classify + plan + critique + synthesize)
    const { executor, mockProvider } = buildExecutor([
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Task1 step", "toolName": "test_tool", "toolArgs": {"input": "1"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Task 1 done.',
      '{"goal": "test", "constraints": [], "successCriteria": []}',
      '{"complexity": 0.3}',
      '{"steps": [{"description": "Task2 step", "toolName": "test_tool", "toolArgs": {"input": "2"}}]}',
      '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
      'Task 2 done.',
    ], tools);

    const result1 = await executor.execute(createTask());
    const result2 = await executor.execute(createTask());

    expect(result1.status).toBe('completed');
    expect(result2.status).toBe('completed');
    expect(result1.taskId).not.toBe(result2.taskId);
    expect(mockProvider.chat).toHaveBeenCalledTimes(10);
  });
});

describe('Integration: Session Management', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-session-int-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create, save, reload, and verify session persistence', async () => {
    const mgr = new SessionManager(tempDir);
    const session = await mgr.create();

    mgr.addMessage(session, { role: 'user', content: 'Hello world', timestamp: new Date().toISOString() });
    mgr.addMessage(session, { role: 'assistant', content: 'Hi there!', timestamp: new Date().toISOString() });
    mgr.updateMetadata(session, { totalCostUsd: 0.005, totalTokens: 250 });
    await mgr.save(session);

    // Reload from disk
    const loaded = await mgr.load(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].content).toBe('Hello world');
    expect(loaded!.metadata.messageCount).toBe(1);
    expect(loaded!.metadata.totalCostUsd).toBe(0.005);
    expect(loaded!.metadata.totalTokens).toBe(250);
  });

  it('should trim history to token budget keeping recent messages', () => {
    const mgr = new SessionManager(tempDir);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'x'.repeat(200)}`,
      timestamp: new Date().toISOString(),
    }));

    // ~200 chars each, 4 chars/token = ~50 tokens per message
    // Budget of 200 tokens should keep ~4 messages
    const trimmed = mgr.trimHistory(messages, 200);
    expect(trimmed.length).toBeLessThan(messages.length);
    expect(trimmed.length).toBeGreaterThan(0);
    // Most recent message should be preserved
    expect(trimmed[trimmed.length - 1].content).toBe(messages[messages.length - 1].content);
  });

  it('should list sessions sorted by most recent', async () => {
    const mgr = new SessionManager(tempDir);

    const s1 = await mgr.create();
    mgr.addMessage(s1, { role: 'user', content: 'First session', timestamp: new Date().toISOString() });
    await mgr.save(s1);

    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));

    const s2 = await mgr.create();
    mgr.addMessage(s2, { role: 'user', content: 'Second session', timestamp: new Date().toISOString() });
    await mgr.save(s2);

    const list = await mgr.list();
    expect(list).toHaveLength(2);
    // Most recent first
    expect(list[0].id).toBe(s2.id);
  });
});

describe('Integration: Scheduler', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-sched-int-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should add schedules and persist to disk', async () => {
    const mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield { type: 'result', result: { taskId: 'test', result: 'ok', budgetUsed: { tokensUsed: 10, energyWh: 0.0001, carbonGrams: 0.0001, costUsd: 0.001, elapsedMs: 50 } } };
      }),
    };

    const scheduleFile = path.join(tempDir, 'schedules.json');
    const logFile = path.join(tempDir, 'logs.json');
    const scheduler = new Scheduler(mockJoule as any, { scheduleFile, logFile });

    const task = await scheduler.add('Test Schedule', '0 9 * * *', 'Check status', 'medium');
    expect(task).toBeTruthy();
    expect(task.name).toBe('Test Schedule');

    const schedules = await scheduler.list();
    expect(schedules).toHaveLength(1);
    expect(schedules[0].name).toBe('Test Schedule');
    expect(schedules[0].cron).toBe('0 9 * * *');

    // Verify file was written
    const content = await fs.readFile(scheduleFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed).toHaveLength(1);
  });
});

describe('Integration: Config Loading', () => {
  let tempDir: string;
  let origCwd: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-config-int-'));
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    // Clean up env vars
    delete process.env.JOULE_ANTHROPIC_API_KEY;
    delete process.env.JOULE_LOG_LEVEL;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should merge YAML config with env var overrides', async () => {
    const yamlContent = `
providers:
  ollama:
    enabled: true
    baseUrl: "http://localhost:11434"
    models:
      slm: "llama3.2:3b"
budgets:
  default: "low"
logging:
  level: "warn"
`;
    await fs.writeFile(path.join(tempDir, 'joule.config.yaml'), yamlContent);

    // Env var overrides logging level
    process.env.JOULE_LOG_LEVEL = 'debug';

    const config = new ConfigManager();
    const result = await config.load();

    expect(result.providers.ollama?.enabled).toBe(true);
    expect(result.budgets.default).toBe('low');
    // Env var should override YAML
    expect(result.logging.level).toBe('debug');
  });

  it('should inject Anthropic config from env var', async () => {
    process.env.JOULE_ANTHROPIC_API_KEY = 'sk-ant-test-key';

    const config = new ConfigManager();
    const result = await config.load();

    expect(result.providers.anthropic).toBeDefined();
    expect(result.providers.anthropic?.apiKey).toBe('sk-ant-test-key');
    expect(result.providers.anthropic?.enabled).toBe(true);
  });

  it('should use defaults when no config file exists', async () => {
    const config = new ConfigManager();
    const result = await config.load();

    expect(result.budgets.default).toBe('medium');
    expect(result.tools.builtinEnabled).toBe(true);
    expect(result.logging.level).toBe('info');
    expect(result.server.port).toBe(3927);
  });
});
