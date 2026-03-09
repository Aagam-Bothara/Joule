import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ComputerAgent } from '../src/computer-agent.js';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ModelRouter } from '../src/model-router.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, BudgetExhaustedError } from '@joule/shared';
import type { RoutingConfig } from '@joule/shared';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockProvider(responses: string[]) {
  let callIndex = 0;
  return {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([
      { id: 'test-llm', name: 'Test LLM', tier: ModelTier.LLM, provider: 'ollama' },
    ]),
    estimateCost: vi.fn().mockReturnValue(0.001),
    chat: vi.fn().mockImplementation(async () => {
      const content = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return {
        model: 'test-llm',
        provider: 'ollama',
        tier: ModelTier.LLM,
        content,
        tokenUsage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        latencyMs: 100,
        costUsd: 0.005,
        finishReason: 'stop' as const,
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
  unifiedPlanning: false,
};

function createMockTools(): ToolRegistry {
  const tools = new ToolRegistry();

  // Mock os_screenshot tool
  tools.register({
    name: 'os_screenshot',
    description: 'Take screenshot',
    inputSchema: z.object({ returnBase64: z.boolean().optional() }),
    outputSchema: z.any(),
    execute: async () => ({
      base64: 'iVBORw0KGgo=',
      width: 1920,
      height: 1080,
    }),
  }, 'builtin');

  // Mock shell_exec tool
  tools.register({
    name: 'shell_exec',
    description: 'Execute shell command',
    inputSchema: z.object({
      command: z.string(),
      timeoutMs: z.number().optional(),
    }),
    outputSchema: z.any(),
    execute: async (input: any) => ({
      stdout: `Executed: ${input.command.slice(0, 50)}`,
      stderr: '',
      exitCode: 0,
    }),
  }, 'builtin');

  // Mock os_keyboard tool
  tools.register({
    name: 'os_keyboard',
    description: 'Keyboard input',
    inputSchema: z.object({
      action: z.string(),
      text: z.string().optional(),
      key: z.string().optional(),
    }),
    outputSchema: z.any(),
    execute: async () => ({ success: true }),
  }, 'builtin');

  // Mock os_window tool
  tools.register({
    name: 'os_window',
    description: 'Window management',
    inputSchema: z.object({
      action: z.string(),
      title: z.string().optional(),
    }),
    outputSchema: z.any(),
    execute: async () => ({ success: true }),
  }, 'builtin');

  // Mock os_open tool
  tools.register({
    name: 'os_open',
    description: 'Open application',
    inputSchema: z.object({ target: z.string() }),
    outputSchema: z.any(),
    execute: async () => ({ success: true }),
  }, 'builtin');

  // Mock os_mouse tool
  tools.register({
    name: 'os_mouse',
    description: 'Mouse control',
    inputSchema: z.object({
      action: z.string(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
    outputSchema: z.any(),
    execute: async () => ({ success: true }),
  }, 'builtin');

  // Mock os_clipboard tool
  tools.register({
    name: 'os_clipboard',
    description: 'Clipboard access',
    inputSchema: z.object({
      action: z.string(),
      text: z.string().optional(),
    }),
    outputSchema: z.any(),
    execute: async () => ({ success: true }),
  }, 'builtin');

  // Mock http_fetch tool
  tools.register({
    name: 'http_fetch',
    description: 'HTTP fetch',
    inputSchema: z.object({ url: z.string(), method: z.string().optional() }),
    outputSchema: z.any(),
    execute: async () => ({ status: 200, body: '{"data": "test"}' }),
  }, 'builtin');

  return tools;
}

function buildAgent(responses: string[], opts?: { maxIterations?: number; maxValidationRetries?: number }) {
  const provider = createMockProvider(responses);
  const registry = new ModelProviderRegistry();
  registry.register(provider);

  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const router = new ModelRouter(registry, budget, defaultRouting);
  const tools = createMockTools();

  const agent = new ComputerAgent(registry, tools, budget, tracer, router, {
    maxIterations: opts?.maxIterations ?? 5,
    screenshotDelay: 0,   // No delays in tests
    batchDelay: 0,
    maxValidationRetries: opts?.maxValidationRetries ?? 2,
  });

  const envelope = budget.createEnvelope({
    maxTokens: 500_000,
    costCeilingUsd: 50,
    maxLatencyMs: 600_000,
    maxToolCalls: 200,
    maxEscalations: 10,
  });

  return { agent, budget, tools, envelope, provider, tracer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComputerAgent', () => {
  // Suppress console.log noise from ComputerAgent
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('basic observe-think-act loop', () => {
    it('should complete when LLM returns done on first iteration', async () => {
      // Response 1: agent thinks (done=true) → response 2: validator approves
      const { agent, envelope } = buildAgent([
        '{"done": true, "reasoning": "Task is already complete"}',
        '{"approved": true, "score": 9, "summary": "Looks good"}',
      ]);

      const result = await agent.run('Open notepad', envelope);

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(1);
      expect(result.validationScore).toBe(9);
    });
  });

  describe('action execution', () => {
    it('should execute actions returned by LLM and continue loop', async () => {
      const { agent, envelope, provider } = buildAgent([
        // Iteration 1: execute shell_exec
        '{"done": false, "actions": [{"action": "shell_exec", "args": {"command": "echo hello"}, "reasoning": "Run command"}]}',
        // Iteration 2: done
        '{"done": true, "reasoning": "Command executed successfully"}',
        // Validator
        '{"approved": true, "score": 8, "summary": "Command ran"}',
      ]);

      const result = await agent.run('Run echo hello', envelope);

      expect(result.success).toBe(true);
      expect(result.actions.length).toBeGreaterThanOrEqual(1);
      expect(result.actions[0].tool).toBe('shell_exec');
    });

    it('should handle single action format (no array)', async () => {
      const { agent, envelope } = buildAgent([
        '{"done": false, "action": "os_open", "args": {"target": "notepad"}, "reasoning": "Opening notepad"}',
        '{"done": true, "reasoning": "Opened"}',
        '{"approved": true, "score": 8}',
      ]);

      const result = await agent.run('Open notepad', envelope);

      expect(result.success).toBe(true);
      expect(result.actions.some(a => a.tool === 'os_open')).toBe(true);
    });
  });

  describe('validation', () => {
    it('should retry when validator rejects output', async () => {
      const { agent, envelope, provider } = buildAgent([
        // Iteration 1: agent says done
        '{"done": true, "reasoning": "Created spreadsheet"}',
        // Validator rejects
        '{"approved": false, "score": 4, "issues": ["Cells are empty"], "fix_instructions": "Fill data"}',
        // Iteration 2: agent fixes (executes shell_exec)
        '{"done": false, "actions": [{"action": "shell_exec", "args": {"command": "fix data"}, "reasoning": "Fixing"}]}',
        // Iteration 3: agent says done again
        '{"done": true, "reasoning": "Fixed the data"}',
        // Validator approves
        '{"approved": true, "score": 8, "summary": "Data filled"}',
      ], { maxValidationRetries: 2 });

      const result = await agent.run('Create Excel spreadsheet', envelope);

      expect(result.success).toBe(true);
      expect(result.validationScore).toBe(8);
      // Should have called chat more than 2 times (retried)
      expect(provider.chat).toHaveBeenCalledTimes(5);
    });

    it('should accept output when max validation retries exceeded', async () => {
      const { agent, envelope } = buildAgent([
        '{"done": true, "reasoning": "Created it"}',
        '{"approved": false, "score": 3, "issues": ["Bad"]}',
        '{"done": false, "actions": [{"action": "shell_exec", "args": {"command": "fix"}, "reasoning": "Fix"}]}',
        '{"done": true, "reasoning": "Fixed"}',
        '{"approved": false, "score": 4, "issues": ["Still bad"]}',
        '{"done": false, "actions": [{"action": "shell_exec", "args": {"command": "fix2"}, "reasoning": "Fix2"}]}',
        '{"done": true, "reasoning": "Fixed again"}',
        '{"approved": false, "score": 5, "issues": ["Mediocre"]}',
      ], { maxValidationRetries: 2 });

      const result = await agent.run('Create presentation', envelope);

      // Should accept after max retries even though validator keeps rejecting
      expect(result.success).toBe(true);
    });
  });

  describe('max iterations', () => {
    it('should return failure when max iterations reached', async () => {
      // Agent never says done
      const responses: string[] = [];
      for (let i = 0; i < 10; i++) {
        responses.push('{"done": false, "actions": [{"action": "os_keyboard", "args": {"action": "type", "text": "x"}, "reasoning": "typing"}]}');
      }

      const { agent, envelope } = buildAgent(responses, { maxIterations: 3 });

      const result = await agent.run('Do something forever', envelope);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Max iterations');
    });
  });

  describe('budget exhaustion', () => {
    it('should stop when budget is exhausted', async () => {
      const { agent, envelope, budget } = buildAgent([
        '{"done": false, "actions": [{"action": "shell_exec", "args": {"command": "echo"}, "reasoning": "test"}]}',
      ], { maxIterations: 10 });

      // Pre-exhaust the budget
      budget.deductTokens(envelope, 500_000, 'test');

      const result = await agent.run('Exhaust budget', envelope);

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Budget exhausted');
    });
  });

  describe('error handling', () => {
    it('should handle screenshot failure gracefully', async () => {
      const { agent, envelope, tools } = buildAgent([
        '{"done": true, "reasoning": "Done somehow"}',
        '{"approved": true, "score": 7}',
      ], { maxIterations: 3 });

      // Override os_screenshot to fail first time, succeed after
      let screenshotCallCount = 0;
      tools.unregister('os_screenshot');
      tools.register({
        name: 'os_screenshot',
        description: 'Take screenshot',
        inputSchema: z.object({ returnBase64: z.boolean().optional() }),
        outputSchema: z.any(),
        execute: async () => {
          screenshotCallCount++;
          if (screenshotCallCount === 1) {
            return { error: 'Display not available' };
          }
          return { base64: 'iVBORw0KGgo=', width: 1920, height: 1080 };
        },
      }, 'builtin');

      // Agent should handle screenshot failure and retry
      const result = await agent.run('Test with failing screenshot', envelope);
      // May succeed or fail depending on iteration flow, but shouldn't throw
      expect(result).toBeDefined();
    });

    it('should handle unknown tool gracefully', async () => {
      const { agent, envelope } = buildAgent([
        '{"done": false, "actions": [{"action": "nonexistent_tool", "args": {}, "reasoning": "test"}]}',
        '{"done": true, "reasoning": "Done after error"}',
        '{"approved": true, "score": 7}',
      ], { maxIterations: 5 });

      const result = await agent.run('Use unknown tool', envelope);
      // Should not crash — agent gets error feedback and continues
      expect(result).toBeDefined();
    });
  });
});
