import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import {
  AgentLifecycleTracker,
  LifecycleTransitionError,
  StepVerifier,
  computeLifecycleMetrics,
  inModelCall,
  inToolWait,
  renderLifecycleTimeline,
  type VerificationPhases,
} from '../src/adaptive/index.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type {
  AgentLifecycleEvent,
  AgentLifecycleState,
  ChatMessage,
  ExecutionMode,
  ModelRequest,
  RoutingConfig,
  StepResult,
  Task,
} from '@joule/shared';

// ── Fixtures ────────────────────────────────────────────────────────

/** Clock the tracker reads, so tests assert exact durations. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const ev = (
  from: AgentLifecycleState,
  to: AgentLifecycleState,
  timestamp: number,
  extra: Partial<AgentLifecycleEvent> = {},
): AgentLifecycleEvent => ({ taskId: 't1', agentId: 'a1', from, to, timestamp, ...extra });

/**
 * The timeline from the instrumentation spec: two model calls around one long
 * tool wait, 8.081s total.
 */
const SPEC_TIMELINE: AgentLifecycleEvent[] = [
  ev('ready', 'model_running', 21, { reason: 'model_start' }),
  ev('model_running', 'ready', 1328, { reason: 'model_end', model: 'qwen2.5' }),
  ev('ready', 'tool_wait', 1341, { reason: 'tool_start', tool: 'shell_exec' }),
  ev('tool_wait', 'ready', 6824, { reason: 'tool_end', tool: 'shell_exec' }),
  ev('ready', 'model_running', 6839, { reason: 'model_start' }),
  ev('model_running', 'ready', 8073, { reason: 'model_end', model: 'qwen2.5' }),
  ev('ready', 'completed', 8081, { reason: 'task_complete' }),
];

// ── Scripted two-tier provider (same shape as adaptive-executor.test.ts) ──

interface Scripts { slm?: string[]; llm?: string[] }

function scriptedProvider(scripts: Scripts) {
  const idx = { slm: 0, llm: 0 };
  const provider = {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: async () => true,
    listModels: async () => [
      { id: 'test-slm', name: 'SLM', tier: ModelTier.SLM, contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
      { id: 'test-llm', name: 'LLM', tier: ModelTier.LLM, contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
    ],
    estimateCost: (_n: number, model: string) => (model === 'test-llm' ? 0.01 : 0.0005),
    chat: async (req: ModelRequest) => {
      const tier = req.tier === ModelTier.LLM ? 'llm' : 'slm';
      const list = scripts[tier] ?? [];
      const content = list[Math.min(idx[tier], list.length - 1)] ?? '{}';
      idx[tier]++;
      return {
        model: `test-${tier}`,
        provider: 'ollama' as const,
        tier: req.tier,
        content,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        latencyMs: 5,
        costUsd: tier === 'llm' ? 0.01 : 0.0005,
        finishReason: 'stop' as const,
      };
    },
    chatStream: async function* (): AsyncGenerator<{ content: string; done: boolean }> { yield { content: '', done: true }; },
  };
  return { provider };
}

const routing: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
  unifiedPlanning: false,
};

function build(scripts: Scripts, tools: ToolRegistry) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  providers.register(scriptedProvider(scripts).provider as any);
  const router = new ModelRouter(providers, budget, routing);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, routing);
  return { executor };
}

function task(mode: ExecutionMode = 'adaptive', description = 'Fix the failing service'): Task {
  return { id: generateId('task'), description, budget: 'high', mode, createdAt: new Date().toISOString() };
}

const toolCall = (toolName: string, toolArgs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action: 'tool_call', thought: 'do it', toolName, toolArgs, plan: ['run tool', 'answer'], ...extra });
const finalAnswer = (answer: string) => JSON.stringify({ action: 'final_answer', answer });

let tools: ToolRegistry;

beforeEach(() => {
  tools = new ToolRegistry();
  tools.register({
    name: 'echo_tool',
    description: 'Echoes input',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ echoed: args.input ?? '' }),
  }, 'builtin');
  tools.register({
    name: 'slow_tool',
    description: 'Takes a moment',
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.any(),
    execute: async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
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

// ── Tracker ─────────────────────────────────────────────────────────

describe('AgentLifecycleTracker — transitions', () => {
  it('records a model call, a tool wait and completion', () => {
    const clock = fakeClock();
    const tracker = new AgentLifecycleTracker({ taskId: 'task-1', agentId: 'agent-1', now: clock.now });

    expect(tracker.current).toBe('ready');
    clock.advance(20);
    tracker.modelStart(undefined, { step: 0 });
    clock.advance(100);
    tracker.modelEnd('test-slm');
    clock.advance(10);
    tracker.toolStart('echo_tool');
    clock.advance(300);
    tracker.toolEnd('echo_tool', { success: true });
    clock.advance(5);
    tracker.complete();

    expect(tracker.current).toBe('completed');
    expect(tracker.isTerminal()).toBe(true);
    expect(tracker.events.map(e => [e.from, e.to, e.reason])).toEqual([
      ['ready', 'model_running', 'model_start'],
      ['model_running', 'ready', 'model_end'],
      ['ready', 'tool_wait', 'tool_start'],
      ['tool_wait', 'ready', 'tool_end'],
      ['ready', 'completed', 'task_complete'],
    ]);
    // Identity comes from the execution context, not from a second source.
    expect(tracker.events.every(e => e.taskId === 'task-1' && e.agentId === 'agent-1')).toBe(true);
    expect(tracker.events[1].model).toBe('test-slm');
    expect(tracker.events[3].tool).toBe('echo_tool');
  });

  it('keeps terminal states terminal', () => {
    const completed = new AgentLifecycleTracker({ taskId: 't' });
    completed.complete();
    expect(() => completed.modelStart()).toThrow(LifecycleTransitionError);
    expect(() => completed.transition('ready')).toThrow(/completed -> ready/);

    const failed = new AgentLifecycleTracker({ taskId: 't' });
    failed.fail(new Error('boom'));
    expect(() => failed.transition('ready')).toThrow(LifecycleTransitionError);

    const cancelled = new AgentLifecycleTracker({ taskId: 't' });
    cancelled.cancel();
    expect(() => cancelled.transition('ready')).toThrow(LifecycleTransitionError);
    expect(cancelled.current).toBe('cancelled');
  });

  it('rejects transitions that skip the ready state', () => {
    const tracker = new AgentLifecycleTracker({ taskId: 't' });
    tracker.modelStart();
    expect(() => tracker.modelStart()).toThrow(LifecycleTransitionError);
    expect(() => tracker.toolStart('echo_tool')).toThrow(LifecycleTransitionError);
    expect(tracker.current).toBe('model_running');
  });

  it('fails or cancels from an active state', () => {
    const failing = new AgentLifecycleTracker({ taskId: 't' });
    failing.modelStart();
    const failure = failing.fail(new Error('provider unavailable'), { step: 3 });
    expect(failure.from).toBe('model_running');
    expect(failure.reason).toBe('error');
    expect(failure.metadata).toMatchObject({ error: 'provider unavailable', step: 3 });

    const cancelling = new AgentLifecycleTracker({ taskId: 't' });
    cancelling.toolStart('slow_tool');
    const cancelled = cancelling.cancel();
    expect(cancelled.from).toBe('tool_wait');
    expect(cancelled.reason).toBe('cancelled');
  });

  it('identifies the agent, never the task: several agents can share one task', () => {
    const a = new AgentLifecycleTracker({ taskId: 'task-123' });
    const b = new AgentLifecycleTracker({ taskId: 'task-123' });

    expect(a.agentId).not.toBe('task-123');
    expect(a.agentId).not.toBe(b.agentId);
    a.complete();
    b.fail(new Error('worker died'));
    expect(a.events[0]).toMatchObject({ taskId: 'task-123', agentId: a.agentId });
    expect(b.events[0]).toMatchObject({ taskId: 'task-123', agentId: b.agentId });
  });

  it('carries a crew agent id, role and parent task on every event', () => {
    const tracker = new AgentLifecycleTracker({
      taskId: 'agent-task-9',
      agentId: 'researcher-1',
      agentRole: 'researcher',
      parentTaskId: 'task-123',
    });
    tracker.modelStart();
    tracker.modelEnd('test-slm');

    expect(tracker.events.every(e => e.agentId === 'researcher-1' && e.parentTaskId === 'task-123' && e.agentRole === 'researcher')).toBe(true);
    expect(tracker.events[0].taskId).toBe('agent-task-9');
  });

  it('logs every transition to the trace as an agent_lifecycle event', () => {
    const budget = new BudgetManager();
    const envelope = budget.createEnvelope('high');
    const tracer = new TraceLogger();
    tracer.createTrace('trace-1', 'task-1', envelope.envelope);
    tracer.startSpan('trace-1', 'task-execution');

    const tracker = new AgentLifecycleTracker({ taskId: 'task-1', tracer, traceId: 'trace-1' });
    tracker.modelStart();
    tracker.modelEnd('test-slm');
    tracker.complete();

    const trace = tracer.getTrace('trace-1', budget.getUsage(envelope));
    const logged = trace.spans[0].events.filter(e => e.type === 'agent_lifecycle');
    expect(logged.map(e => e.data.to)).toEqual(['model_running', 'ready', 'completed']);
    expect(logged[1].data.model).toBe('test-slm');
  });
});

// ── Metrics ─────────────────────────────────────────────────────────

describe('computeLifecycleMetrics', () => {
  it('splits runtime into model time, tool wait and other', () => {
    const m = computeLifecycleMetrics(SPEC_TIMELINE, { startTime: 0 });
    expect(m.totalRuntimeMs).toBe(8081);
    expect(m.modelRuntimeMs).toBe(2541);
    expect(m.toolWaitMs).toBe(5483);
    expect(m.otherMs).toBe(57);
    expect(m.idleFraction).toBeCloseTo(5483 / 8081, 6);
    expect(m.modelCalls).toBe(2);
    expect(m.toolCalls).toBe(1);
    expect(m.avgToolWaitMs).toBe(5483);
    expect(m.p95ToolWaitMs).toBe(5483);
    expect(m.finalState).toBe('completed');
  });

  it('handles a run with no tool calls', () => {
    const m = computeLifecycleMetrics([
      ev('ready', 'model_running', 10),
      ev('model_running', 'ready', 110),
      ev('ready', 'completed', 120),
    ], { startTime: 0 });
    expect(m.toolCalls).toBe(0);
    expect(m.toolWaitMs).toBe(0);
    expect(m.idleFraction).toBe(0);
    expect(m.avgToolWaitMs).toBe(0);
    expect(m.p95ToolWaitMs).toBe(0);
    expect(m.modelRuntimeMs).toBe(100);
  });

  it('handles a run with no model calls', () => {
    const m = computeLifecycleMetrics([
      ev('ready', 'tool_wait', 5),
      ev('tool_wait', 'ready', 205),
      ev('ready', 'completed', 210),
    ], { startTime: 0 });
    expect(m.modelCalls).toBe(0);
    expect(m.modelRuntimeMs).toBe(0);
    expect(m.toolWaitMs).toBe(200);
    expect(m.idleFraction).toBeCloseTo(200 / 210, 6);
  });

  it('handles no events and a zero-duration run without dividing by zero', () => {
    const empty = computeLifecycleMetrics([]);
    expect(empty).toMatchObject({
      totalRuntimeMs: 0, modelRuntimeMs: 0, toolWaitMs: 0, idleFraction: 0,
      otherMs: 0, modelCalls: 0, toolCalls: 0, avgToolWaitMs: 0, p95ToolWaitMs: 0, finalState: 'ready',
    });
    expect(Number.isFinite(empty.idleFraction)).toBe(true);

    const instant = computeLifecycleMetrics([ev('ready', 'completed', 0)], { startTime: 0 });
    expect(instant.totalRuntimeMs).toBe(0);
    expect(instant.idleFraction).toBe(0);
    expect(instant.finalState).toBe('completed');
  });

  it('counts time spent in the call a failure or cancellation interrupted', () => {
    const failed = computeLifecycleMetrics([
      ev('ready', 'model_running', 10),
      ev('model_running', 'failed', 60, { reason: 'error' }),
    ], { startTime: 0 });
    expect(failed.modelRuntimeMs).toBe(50);
    expect(failed.totalRuntimeMs).toBe(60);
    expect(failed.finalState).toBe('failed');

    const cancelled = computeLifecycleMetrics([
      ev('ready', 'tool_wait', 10),
      ev('tool_wait', 'cancelled', 90, { reason: 'cancelled' }),
    ], { startTime: 0 });
    expect(cancelled.toolWaitMs).toBe(80);
    expect(cancelled.toolCalls).toBe(1);
    expect(cancelled.finalState).toBe('cancelled');
  });

  it('closes an unfinished run at the given clock', () => {
    const events = [ev('ready', 'tool_wait', 10)];
    const m = computeLifecycleMetrics(events, { startTime: 0, now: 500 });
    expect(m.totalRuntimeMs).toBe(500);
    expect(m.toolWaitMs).toBe(490);
    expect(m.finalState).toBe('tool_wait');

    // Without a clock the run is closed at its last event.
    const closed = computeLifecycleMetrics(events, { startTime: 0 });
    expect(closed.totalRuntimeMs).toBe(10);
    expect(closed.toolWaitMs).toBe(0);
  });

  it('reports average and p95 over individual tool waits', () => {
    const timeline = (waits: number[]): AgentLifecycleEvent[] => {
      const events: AgentLifecycleEvent[] = [];
      let t = 0;
      for (const wait of waits) {
        events.push(ev('ready', 'tool_wait', t));
        t += wait;
        events.push(ev('tool_wait', 'ready', t));
        t += 1;
      }
      return events;
    };

    // Eighteen 10ms waits and two 200ms waits: nearest rank puts p95 in the tail.
    const m = computeLifecycleMetrics(timeline([...Array(18).fill(10), 200, 200]), { startTime: 0 });
    expect(m.toolCalls).toBe(20);
    expect(m.avgToolWaitMs).toBeCloseTo((18 * 10 + 400) / 20, 6);
    expect(m.p95ToolWaitMs).toBe(200);

    // One lone slow wait among twenty sits above the 95th percentile.
    expect(computeLifecycleMetrics(timeline([...Array(19).fill(10), 200]), { startTime: 0 }).p95ToolWaitMs).toBe(10);
    // A single sample is its own percentile.
    expect(computeLifecycleMetrics(timeline([42]), { startTime: 0 }).p95ToolWaitMs).toBe(42);
  });

  it('derives the same totals from a tracker as from its events', () => {
    const clock = fakeClock(1000);
    const tracker = new AgentLifecycleTracker({ taskId: 't', now: clock.now });
    clock.advance(5);
    tracker.modelStart();
    clock.advance(50);
    tracker.modelEnd('test-slm');
    clock.advance(200);
    tracker.complete();

    expect(tracker.metrics()).toEqual(computeLifecycleMetrics(tracker.events, { startTime: tracker.startTime }));
    expect(tracker.metrics().modelRuntimeMs).toBe(50);
  });
});

// ── Formatter ───────────────────────────────────────────────────────

describe('renderLifecycleTimeline', () => {
  it('prints the timeline and the split', () => {
    const out = renderLifecycleTimeline('task-1', SPEC_TIMELINE, { startTime: 0 });
    expect(out).toContain('Task: task-1');
    expect(out).toMatch(/0\.000s\s+READY/);
    expect(out).toMatch(/1\.341s\s+TOOL_WAIT\s+shell_exec/);
    // The model is known when the call returns, so the MODEL_RUNNING line borrows it.
    expect(out).toMatch(/0\.021s\s+MODEL_RUNNING\s+qwen2\.5/);
    // A state the agent merely returns to carries no label.
    expect(out).toMatch(/1\.328s\s+READY$/m);
    expect(out).toMatch(/8\.081s\s+COMPLETED/);
    expect(out).toMatch(/Total:\s+8\.081s/);
    expect(out).toMatch(/Model:\s+2\.541s\s+31\.4%/);
    expect(out).toMatch(/Tool wait:\s+5\.483s\s+67\.9%/);
    expect(out).toMatch(/Other:\s+0\.057s\s+0\.7%/);
  });

  it('prints a run that has no events', () => {
    expect(renderLifecycleTimeline('task-2', [])).toContain('READY');
  });
});

// ── Verification phases ─────────────────────────────────────────────

describe('verification phases', () => {
  it('counts an LLM judge as model time and a command check as tool wait', async () => {
    const clock = fakeClock();
    const tracker = new AgentLifecycleTracker({ taskId: 'task-1', now: clock.now });
    const phases: VerificationPhases = {
      tool: (name, run) => inToolWait(tracker, name, run),
      model: run => inModelCall(tracker, run),
    };
    const verifyTools = new ToolRegistry();
    verifyTools.register({
      name: 'shell_exec',
      description: 'Fake shell that takes 200ms',
      inputSchema: z.object({ command: z.string() }).passthrough(),
      outputSchema: z.any(),
      execute: async () => { clock.advance(200); return { stdout: 'ok', stderr: '', exitCode: 0 }; },
    }, 'builtin');
    const verifier = new StepVerifier(verifyTools, {
      allowLlmJudge: true,
      judge: async () => { clock.advance(500); return { passed: true, evidence: 'looks right' }; },
    });
    const step: StepResult = {
      stepIndex: 0, toolName: 'echo_tool', toolArgs: {}, output: { stdout: 'ok', exitCode: 0 },
      success: true, durationMs: 1,
    };

    const judged = await verifier.verify({ type: 'llm_judge', assertion: 'did it work?' }, step, phases);
    const checked = await verifier.verify({ type: 'command_exit', command: 'exit 0' }, step, phases);

    expect(judged.kind).toBe('llm_judge');
    expect(checked.kind).toBe('command_exit');
    // Inference inside verification is model time, not idle: idleFraction depends on it.
    const m = tracker.metrics();
    expect(m.modelRuntimeMs).toBe(500);
    expect(m.modelCalls).toBe(1);
    expect(m.toolWaitMs).toBe(200);
    expect(m.toolCalls).toBe(1);
  });

  it('verifies unchanged when no phases are supplied', async () => {
    const verifier = new StepVerifier(tools);
    const step: StepResult = {
      stepIndex: 0, toolName: 'shell_exec', toolArgs: { command: 'exit 0' },
      output: { stdout: '3 passed', stderr: '', exitCode: 0 }, success: true, durationMs: 1,
    };
    await expect(verifier.verify({ type: 'command_exit', command: 'exit 0' }, step))
      .resolves.toMatchObject({ passed: true, kind: 'command_exit' });
  });

  it('closes the segment when the wrapped call throws', async () => {
    const tracker = new AgentLifecycleTracker({ taskId: 'task-1' });
    await expect(inToolWait(tracker, 'shell_exec', async () => { throw new Error('exploded'); })).rejects.toThrow('exploded');
    expect(tracker.current).toBe('ready');
    await expect(inModelCall(tracker, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(tracker.current).toBe('ready');
  });
});

// ── Instrumentation in the real execution path ──────────────────────

describe('lifecycle instrumentation — adaptive executor', () => {
  it('tracks model calls and tool waits through a completed run, leaving behaviour unchanged', async () => {
    const { executor } = build({ slm: [toolCall('echo_tool', { input: 'hi' }), finalAnswer('done: hi')] }, tools);

    const result = await executor.execute(task('adaptive'));

    // Existing behaviour.
    expect(result.status).toBe('completed');
    expect(result.result).toBe('done: hi');
    expect(result.trajectory?.trajectoryLength).toBe(2);

    const events = result.trajectory!.lifecycle!;
    expect(events.map(e => e.to)).toEqual([
      'model_running', 'ready',   // first agent turn
      'tool_wait', 'ready',       // echo_tool
      'model_running', 'ready',   // second agent turn
      'completed',
    ]);
    // The deterministic auto-check reads the tool output in memory: no wait to record.
    expect(events.filter(e => e.reason === 'tool_start').map(e => e.tool)).toEqual(['echo_tool']);
    expect(events.find(e => e.reason === 'model_end')?.model).toBe('test-slm');
    expect(events.every(e => e.taskId === result.taskId)).toBe(true);
    expect(new Set(events.map(e => e.agentId)).size).toBe(1);

    const metrics = result.trajectory!.lifecycleMetrics!;
    expect(metrics.modelCalls).toBe(2);
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.finalState).toBe('completed');
    expect(metrics.modelRuntimeMs + metrics.toolWaitMs + metrics.otherMs).toBe(metrics.totalRuntimeMs);
    expect(metrics.idleFraction).toBeGreaterThanOrEqual(0);
    expect(metrics.idleFraction).toBeLessThanOrEqual(1);

    // The debug formatter reconstructs the timeline from a finished run.
    const timeline = renderLifecycleTimeline(result.taskId, events);
    expect(timeline).toContain(`Task: ${result.taskId}`);
    expect(timeline).toMatch(/TOOL_WAIT\s+echo_tool/);
    expect(timeline).toMatch(/MODEL_RUNNING\s+test-slm/);
    expect(timeline).toContain('COMPLETED');
  });

  it('attributes a slow tool to tool wait', async () => {
    const { executor } = build({ slm: [toolCall('slow_tool', {}), finalAnswer('done')] }, tools);

    const result = await executor.execute(task('adaptive'));

    const metrics = result.trajectory!.lifecycleMetrics!;
    expect(metrics.toolWaitMs).toBeGreaterThanOrEqual(20);
    expect(metrics.totalRuntimeMs).toBeGreaterThanOrEqual(metrics.toolWaitMs);
    expect(metrics.idleFraction).toBeGreaterThan(0);
  });

  it('ends in failed when the run fails, without swallowing the failure', async () => {
    const { executor } = build({ slm: [toolCall('always_fails', {})] }, tools);

    const result = await executor.execute(task('slm-only'));

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    const events = result.trajectory!.lifecycle!;
    expect(events[events.length - 1]).toMatchObject({ to: 'failed', reason: 'error' });
    expect(result.trajectory!.lifecycleMetrics!.finalState).toBe('failed');
    // A failed tool call is still a tool wait that ended.
    expect(events.filter(e => e.reason === 'tool_end').length).toBeGreaterThan(0);
  });

  it('records a consultation as model time on the advisor tier', async () => {
    const { executor } = build({
      slm: [toolCall('always_fails', {}), toolCall('always_fails', {}), finalAnswer('recovered')],
      llm: ['Try the other endpoint.'],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    const events = result.trajectory!.lifecycle!;
    const consultStarts = events.filter(e => e.reason === 'model_start' && e.metadata?.consultId !== undefined);
    expect(consultStarts.length).toBeGreaterThan(0);
    expect(consultStarts[0].metadata?.tier).toBe(ModelTier.LLM);
    expect(events.find(e => e.model === 'test-llm')).toBeDefined();
  });

  it('records a declared command verifier as its own tool wait', async () => {
    const { executor } = build({
      slm: [toolCall('echo_tool', { input: 'hi' }, { verify: { type: 'command_exit', command: 'exit 0' } }), finalAnswer('done')],
    }, tools);

    const result = await executor.execute(task('adaptive'));

    const waits = result.trajectory!.lifecycle!.filter(e => e.reason === 'tool_start');
    expect(waits.map(e => e.tool)).toEqual(['echo_tool', 'shell_exec']);
    expect(waits[1].metadata).toMatchObject({ phase: 'verify' });
    expect(result.trajectory!.lifecycleMetrics!.toolCalls).toBe(2);
  });

  it('uses the agent identity the task carries, so crew agents stay distinct', async () => {
    const { executor } = build({ slm: [finalAnswer('done')] }, tools);
    const crewTask: Task = { ...task('adaptive'), agentId: 'writer-2', agentRole: 'writer', parentTaskId: 'task-crew-1' };

    const result = await executor.execute(crewTask);

    const events = result.trajectory!.lifecycle!;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.agentId === 'writer-2' && e.agentRole === 'writer' && e.parentTaskId === 'task-crew-1')).toBe(true);
    expect(events[0].taskId).toBe(crewTask.id);
  });
});
