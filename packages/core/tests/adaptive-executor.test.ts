import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { buildTrajectoryFromTrace, renderTrajectory } from '../src/adaptive/index.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, ChatMessage, ModelRequest, ExecutionMode, BudgetEnvelope } from '@joule/shared';

// ── Scripted two-tier provider ──────────────────────────────────────

interface Scripts { slm?: string[]; llm?: string[] }

function scriptedProvider(scripts: Scripts, opts: { llmTier?: boolean } = {}) {
  const idx = { slm: 0, llm: 0 };
  const calls: Array<{ tier: 'slm' | 'llm'; system: string; messages: ChatMessage[]; maxTokens?: number }> = [];
  const hasLlm = opts.llmTier !== false;
  const provider = {
    name: 'ollama' as const,
    supportedTiers: hasLlm ? [ModelTier.SLM, ModelTier.LLM] : [ModelTier.SLM],
    isAvailable: async () => true,
    listModels: async () => [
      { id: 'test-slm', name: 'SLM', tier: ModelTier.SLM, contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
      ...(hasLlm ? [{ id: 'test-llm', name: 'LLM', tier: ModelTier.LLM, contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 }] : []),
    ],
    estimateCost: (_n: number, model: string) => (model === 'test-llm' ? 0.01 : 0.0005),
    chat: async (req: ModelRequest) => {
      const tier = req.tier === ModelTier.LLM ? 'llm' : 'slm';
      // Copy: the executor mutates its message array after the call.
      calls.push({ tier, system: req.system ?? '', messages: req.messages.map(m => ({ ...m })), maxTokens: req.maxTokens });
      const list = scripts[tier] ?? [];
      const content = list[Math.min(idx[tier], list.length - 1)] ?? '{}';
      idx[tier]++;
      return {
        model: tier === 'llm' ? 'test-llm' : 'test-slm',
        provider: 'ollama' as const,
        tier: req.tier,
        content,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        latencyMs: 5,
        costUsd: tier === 'llm' ? 0.01 : 0.0005,
        finishReason: 'stop' as const,
      };
    },
    chatStream: async function* () { yield { content: '', done: true }; },
  };
  return { provider, calls };
}

const routing: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
  unifiedPlanning: false,
};

function build(scripts: Scripts, tools: ToolRegistry, overrides: Partial<RoutingConfig> = {}, providerOpts: { llmTier?: boolean } = {}) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  const scripted = scriptedProvider(scripts, providerOpts);
  providers.register(scripted.provider as any);
  const cfg = { ...routing, ...overrides };
  const router = new ModelRouter(providers, budget, cfg);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, cfg);
  return { executor, budget, tracer, calls: scripted.calls };
}

function task(mode?: ExecutionMode, budget: Task['budget'] = 'high', description = 'Fix the failing service'): Task {
  return { id: generateId('task'), description, budget, mode, createdAt: new Date().toISOString() };
}

const toolCall = (toolName: string, toolArgs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action: 'tool_call', thought: 'do it', toolName, toolArgs, plan: ['run tool', 'answer'], ...extra });
const finalAnswer = (answer: string) => JSON.stringify({ action: 'final_answer', answer });

// ── Tools ───────────────────────────────────────────────────────────

let tools: ToolRegistry;
let flakyFailures: number;

beforeEach(() => {
  tools = new ToolRegistry();
  flakyFailures = 0;
  tools.register({
    name: 'echo_tool',
    description: 'Echoes input',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ echoed: args.input ?? '' }),
  }, 'builtin');
  tools.register({
    name: 'flaky_tool',
    description: 'Fails the first N times',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async () => {
      if (flakyFailures > 0) {
        flakyFailures--;
        throw new Error('ECONNREFUSED connecting to auth service at 10.0.0.12:8443');
      }
      return { ok: true };
    },
  }, 'builtin');
  tools.register({
    name: 'always_fails',
    description: 'Always fails',
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.any(),
    execute: async () => { throw new Error('permission denied'); },
  }, 'builtin');
  tools.register({
    name: 'shell_exec',
    description: 'Fake shell: exit code = number in command',
    inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => {
      const code = Number((args.command as string).match(/exit\s+(\d+)/)?.[1] ?? 0);
      return { stdout: code === 0 ? '3 passed' : '', stderr: code === 0 ? '' : '1 failed', exitCode: code };
    },
  }, 'builtin');
});

// ── Tests ───────────────────────────────────────────────────────────

describe('AdaptiveExecutor — modes and escalation', () => {
  it('adaptive: SLM completes a task with one tool call and a final answer', async () => {
    const { executor, calls } = build({
      slm: [toolCall('echo_tool', { input: 'hi' }), finalAnswer('done: hi')],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('completed');
    expect(result.result).toBe('done: hi');
    expect(result.mode).toBe('adaptive');
    expect(result.stepResults).toHaveLength(1);
    expect(result.stepResults[0].tier).toBe(ModelTier.SLM);
    expect(result.stepResults[0].model).toBe('test-slm');
    expect(calls.every(c => c.tier === 'slm')).toBe(true);

    const t = result.trajectory!;
    expect(t.consultations).toBe(0);
    expect(t.handoffs).toBe(0);
    expect(t.trajectoryLength).toBe(2);
    expect(t.slmTokens).toBe(300);
    expect(t.llmTokens).toBe(0);
    expect(t.steps.map(s => s.action)).toEqual(['continue', 'continue']);
    expect(result.trace.tierUsage?.slmCalls).toBe(2);
    expect(result.executionState?.planVersions[0].steps).toEqual(['run tool', 'answer']);
  });

  it('adaptive: repeated identical failure triggers CONSULT, advice returns to the SLM, task completes without handoff', async () => {
    flakyFailures = 2;
    const { executor, calls } = build({
      slm: [
        toolCall('flaky_tool', { input: 'a' }),
        toolCall('flaky_tool', { input: 'a' }),
        toolCall('flaky_tool', { input: 'retry-with-advice' }),
        finalAnswer('fixed'),
      ],
      llm: ['Retry with a backoff and check the auth service port; it is 8443 not 8080.'],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('completed');
    const t = result.trajectory!;
    expect(t.consultations).toBe(1);
    expect(t.handoffs).toBe(0);
    expect(t.steps.map(s => s.action)).toEqual(['continue', 'consult', 'continue', 'continue']);
    expect(t.consults[0].model).toBe('test-llm');
    expect(t.consults[0].tokens).toBe(150);

    // The consultation was a single focused call at the LLM tier with only the evidence packet.
    const llmCalls = calls.filter(c => c.tier === 'llm');
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].messages).toHaveLength(1);
    expect(llmCalls[0].messages[0].content).toContain('QUESTION');
    expect(llmCalls[0].messages[0].content).toContain('flaky_tool');
    expect(llmCalls[0].maxTokens).toBe(800);

    // The SLM's next turn saw the advice, and the following step is attributed to the consult.
    const slmAfterAdvice = calls.filter(c => c.tier === 'slm')[2];
    expect(slmAfterAdvice.messages.at(-1)?.content).toContain('<advice consult="c1">');
    expect(result.stepResults[2].consultId).toBe('c1');
    expect(result.stepResults[2].success).toBe(true);
    expect(result.trace.tierUsage).toMatchObject({ slmCalls: 4, llmCalls: 1, llmTokens: 150 });
  });

  it('adaptive: three failures trigger HANDOFF; the LLM continues from the handoff context, not from scratch', async () => {
    const { executor, budget, calls } = build({
      slm: [
        toolCall('always_fails', {}),
        toolCall('always_fails', {}),
        toolCall('always_fails', {}),
      ],
      llm: [
        'Use echo_tool instead.',                 // consultation answer (after 2nd failure)
        toolCall('echo_tool', { input: 'from-llm' }),
        finalAnswer('llm finished it'),
      ],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('completed');
    expect(result.result).toBe('llm finished it');
    const t = result.trajectory!;
    expect(t.consultations).toBe(1);
    expect(t.handoffs).toBe(1);
    expect(t.handoffAtStep).toBe(2);
    expect(t.steps.map(s => s.action)).toEqual(['continue', 'consult', 'handoff', 'continue', 'continue']);
    expect(result.stepResults[3].tier).toBe(ModelTier.LLM);
    expect(result.executionState?.tier).toBe(ModelTier.LLM);
    expect(result.budgetUsed.escalationsUsed).toBe(1);

    // Handoff prompt carries the state: goal, failures, advice — and is not the original task prompt.
    const firstLlmTurn = calls.filter(c => c.tier === 'llm')[1];
    expect(firstLlmTurn.messages).toHaveLength(1);
    const handoff = firstLlmTurn.messages[0].content;
    expect(handoff).toContain('taking over an in-progress task');
    expect(handoff).toContain('FAILURES');
    expect(handoff).toContain('always_fails');
    expect(handoff).toContain('ADVICE ALREADY RECEIVED');
    expect(handoff).not.toContain('Begin. Respond with your first action');
    expect(result.trace.tierUsage?.llmTokens).toBe(450);
  });

  it('slm-only: never consults or hands off; repeated failure ends in abort', async () => {
    const { executor, calls } = build({
      slm: [toolCall('always_fails', {}), toolCall('always_fails', {}), toolCall('always_fails', {}), toolCall('always_fails', {})],
      llm: ['should never be called'],
    }, tools);

    const result = await executor.execute(task('slm-only'));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('escalation disabled');
    expect(calls.some(c => c.tier === 'llm')).toBe(false);
    const t = result.trajectory!;
    expect(t.mode).toBe('slm-only');
    expect(t.consultations).toBe(0);
    expect(t.handoffs).toBe(0);
    expect(t.steps.map(s => s.action)).toEqual(['continue', 'continue', 'abort']);
    expect(t.llmTokens).toBe(0);
  });

  it('llm-only: starts at the LLM tier and stays there', async () => {
    const { executor, calls } = build({
      slm: ['should never be called'],
      llm: [toolCall('echo_tool', { input: 'x' }), finalAnswer('ok')],
    }, tools);

    const result = await executor.execute(task('llm-only'));

    expect(result.status).toBe('completed');
    expect(calls.every(c => c.tier === 'llm')).toBe(true);
    expect(result.stepResults[0].tier).toBe(ModelTier.LLM);
    expect(result.trajectory?.slmTokens).toBe(0);
    expect(result.trajectory?.llmTokens).toBe(300);
    expect(result.trajectory?.handoffs).toBe(0);
  });

  it('adaptive without an LLM provider: cannot escalate, aborts at the step limit', async () => {
    const { executor } = build(
      { slm: [toolCall('always_fails', {})] },
      tools,
      { escalation: { maxSteps: 5 } },
      { llmTier: false },
    );

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('failed');
    expect(result.error).toContain('step limit');
    expect(result.trajectory?.handoffs).toBe(0);
    expect(result.trajectory?.consultations).toBe(0);
    expect(result.trajectory?.steps.some(s => s.reason.includes('no LLM provider available'))).toBe(true);
  });

  it('adaptive: two malformed SLM responses hand off to the LLM', async () => {
    const { executor } = build({
      slm: ['I think we should look at the files first.', 'Sure, let me help with that!'],
      llm: [finalAnswer('answer from llm')],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('completed');
    expect(result.result).toBe('answer from llm');
    expect(result.trajectory?.handoffs).toBe(1);
    expect(result.executionState?.failures.map(f => f.kind)).toEqual(['malformed_action', 'malformed_action']);
  });

  it('adaptive: the agent can ask a focused question itself (ask_consult)', async () => {
    const { executor, calls } = build({
      slm: [
        toolCall('echo_tool', { input: 'inspect refresh path' }),
        JSON.stringify({ action: 'ask_consult', question: 'Locking or optimistic versioning for the refresh race?', hypotheses: ['both refreshes write the same row'] }),
        toolCall('echo_tool', { input: 'apply lock' }),
        finalAnswer('implemented lock'),
      ],
      llm: ['Use a short-lived row lock; optimistic versioning would retry too often here.'],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('completed');
    expect(result.trajectory?.consultations).toBe(1);
    expect(result.trajectory?.consults[0].question).toContain('Locking or optimistic');
    expect(result.executionState?.hypotheses[0].text).toContain('same row');
    expect(result.trajectory?.steps[1].action).toBe('consult');
    expect(calls.filter(c => c.tier === 'slm')[2].messages.at(-1)?.content).toContain('row lock');
  });

  it('adaptive: deterministic verification — a non-zero exit code fails the step even though the tool succeeded', async () => {
    const { executor } = build({
      slm: [
        toolCall('shell_exec', { command: 'npm test; exit 1' }, { verify: { type: 'command_exit', command: 'npm test; exit 1' } }),
        toolCall('shell_exec', { command: 'npm test; exit 1' }, { verify: { type: 'command_exit', command: 'npm test; exit 1' } }),
        toolCall('shell_exec', { command: 'npm test; exit 0' }),
        finalAnswer('tests green'),
      ],
      llm: ['The failing test expects the null check before the lookup.'],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    expect(result.status).toBe('completed');
    expect(result.stepResults[0].success).toBe(true);
    expect(result.stepResults[0].verified).toBe(false);
    expect(result.stepResults[0].verifierKind).toBe('command_exit');
    // First verification failure is the agent's to retry; the second with no improvement consults.
    expect(result.trajectory?.steps[0].action).toBe('continue');
    expect(result.trajectory?.steps[1].action).toBe('consult');
    // Identical failure twice is a repeat; a different failure with no improvement is the verify rule.
    expect(result.trajectory?.steps[1].reason).toMatch(/repeated|no improvement/);
    // Auto-verification without a declared verifier still reads the exit code.
    expect(result.stepResults[2].verified).toBe(true);
    expect(result.trajectory?.verifierKinds).toEqual(['command_exit']);
  });

  it('budget exhaustion inside the loop surfaces as budget_exhausted with a partial result', async () => {
    const budget: Partial<BudgetEnvelope> = { maxTokens: 100_000, maxLatencyMs: 60_000, maxToolCalls: 1, maxEscalations: 2, costCeilingUsd: 1 };
    const { executor } = build({
      slm: [toolCall('echo_tool', { input: 'one' }), toolCall('echo_tool', { input: 'two' }), toolCall('echo_tool', { input: 'three' })],
    }, tools);

    const result = await executor.execute(task('adaptive', budget));

    expect(result.status).toBe('budget_exhausted');
    expect(result.result).toContain('Partial Result');
    expect(result.stepResults.length).toBeGreaterThanOrEqual(1);
    expect(result.trajectory?.status).toBe('budget_exhausted');
  });

  it('static-router stays the default and is unaffected', async () => {
    const { executor } = build({
      slm: [
        '{"goal": "test", "constraints": [], "successCriteria": [{"description": "done", "type": "tool_succeeded", "check": {}}]}',
        '{"complexity": 0.3}',
        '{"steps": [{"description": "Run tool", "toolName": "echo_tool", "toolArgs": {"input": "hello"}}]}',
        '{"overall": 0.8, "stepConfidences": [0.8], "issues": []}',
        'Result synthesized.',
      ],
    }, tools);

    const result = await executor.execute(task(undefined));

    expect(result.status).toBe('completed');
    expect(result.mode).toBe('static-router');
    expect(result.trajectory).toBeUndefined();
    expect(result.stepResults[0].toolName).toBe('echo_tool');
  });

  it('routing.defaultMode switches the default without touching the task', async () => {
    const { executor } = build({
      slm: [toolCall('echo_tool', { input: 'hi' }), finalAnswer('ok')],
    }, tools, { defaultMode: 'adaptive' });

    const result = await executor.execute(task(undefined));
    expect(result.mode).toBe('adaptive');
    expect(result.trajectory).toBeDefined();
  });

  it('executeStream in adaptive mode yields progress, one chunk and the result', async () => {
    const { executor } = build({
      slm: [toolCall('echo_tool', { input: 'hi' }), finalAnswer('streamed answer')],
    }, tools);

    const events: string[] = [];
    let text = '';
    for await (const ev of executor.executeStream(task('adaptive'))) {
      events.push(ev.type);
      if (ev.type === 'chunk') text += ev.chunk?.content ?? '';
    }
    expect(events).toEqual(['progress', 'chunk', 'chunk', 'result']);
    expect(text).toBe('streamed answer');
  });

  it('trajectory can be rebuilt from the trace alone and rendered', async () => {
    flakyFailures = 2;
    const { executor } = build({
      slm: [toolCall('flaky_tool', {}), toolCall('flaky_tool', {}), toolCall('flaky_tool', {}), finalAnswer('done')],
      llm: ['advice'],
    }, tools);

    const result = await executor.execute(task('adaptive'));
    const fromTrace = buildTrajectoryFromTrace(result.trace)!;

    expect(fromTrace).not.toBeNull();
    expect(fromTrace.mode).toBe('adaptive');
    expect(fromTrace.status).toBe('completed');
    expect(fromTrace.consultations).toBe(1);
    expect(fromTrace.steps.map(s => s.action)).toEqual(result.trajectory!.steps.map(s => s.action));
    expect(fromTrace.slmTokens).toBe(result.trajectory!.slmTokens);

    const rendered = renderTrajectory(result.trajectory!);
    expect(rendered).toContain('SLM start');
    expect(rendered).toContain('CONSULT');
    expect(rendered).toContain('└─ Complete');
    expect(rendered).toContain('Estimated LLM-only');
  });
});
