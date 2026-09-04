import { describe, it, expect } from 'vitest';
import { ModelTier, type BudgetUsage, type ExecutionMode, type StepResult } from '@joule/shared';
import { RuleBasedEscalationPolicy, type PolicyInput } from '../src/adaptive/escalation-policy.js';
import { ConfidenceEngine } from '../src/adaptive/confidence-engine.js';
import { createExecutionState, recordFailure, recordStep, pushPlan, toHandoffContext, renderHandoff, normalizeErrorSignature, maxRepeatedFailure } from '../src/adaptive/execution-state.js';
import { computeTierUsage } from '../src/trace-logger.js';
import { BudgetManager } from '../src/budget-manager.js';
import { StepAgent } from '../src/adaptive/step-agent.js';

const usage = (over: Partial<BudgetUsage> = {}): BudgetUsage => ({
  tokensUsed: 1000, tokensRemaining: 15000, toolCallsUsed: 2, toolCallsRemaining: 8,
  escalationsUsed: 0, escalationsRemaining: 1, costUsd: 0.01, costRemaining: 0.09,
  elapsedMs: 100, latencyRemaining: 29_000, ...over,
});

function state(mode: ExecutionMode = 'adaptive', tier = ModelTier.SLM) {
  return createExecutionState({ taskId: 't1', goal: 'fix the bug', mode, tier, budget: usage() });
}

function step(over: Partial<StepResult>): StepResult {
  return { stepIndex: 0, toolName: 'tool', toolArgs: {}, output: 'ok', success: true, durationMs: 1, ...over };
}

function input(s: ReturnType<typeof state>, over: Partial<PolicyInput> = {}): PolicyInput {
  const engine = new ConfidenceEngine();
  return {
    state: s,
    confidence: engine.compute(s, usage()),
    llmAvailable: true,
    canEscalate: true,
    canAfford: () => true,
    estimatedConsultCostUsd: 0.005,
    estimatedHandoffCostUsd: 0.02,
    minTurnTokens: 400,
    ...over,
  };
}

describe('ConfidenceEngine', () => {
  const engine = new ConfidenceEngine();

  it('starts neutral-high with no evidence and rises with verified successes', () => {
    const s = state();
    const fresh = engine.compute(s, usage());
    expect(fresh.toolSuccess).toBe(0.5);
    expect(fresh.verification).toBe(0.5);
    recordStep(s, step({ verified: true }));
    const after = engine.compute(s, usage());
    expect(after.composite).toBeGreaterThan(fresh.composite);
    expect(after.verification).toBe(1);
  });

  it('drops below the consult threshold after two identical failures', () => {
    const s = state();
    recordStep(s, step({ success: false, error: 'boom' }));
    recordFailure(s, { toolName: 'tool', message: 'ECONNREFUSED 10.0.0.1:8443', kind: 'tool_error' });
    const one = engine.compute(s, usage());
    recordStep(s, step({ stepIndex: 1, success: false, error: 'boom' }));
    recordFailure(s, { toolName: 'tool', message: 'ECONNREFUSED 10.0.0.2:8443', kind: 'tool_error' });
    const two = engine.compute(s, usage());
    expect(one.repeatedFailure).toBe(0);
    expect(two.repeatedFailure).toBe(0.5);
    expect(two.composite).toBeLessThan(one.composite);
    expect(two.composite).toBeLessThan(0.55);
  });

  it('flags a contradiction when the tool succeeded but verification failed', () => {
    const s = state();
    recordStep(s, step({ success: true, verified: false }));
    const c = engine.compute(s, usage());
    expect(c.contradiction).toBe(1);
    expect(c.verification).toBe(0);
  });

  it('never uses model self-reported confidence', () => {
    const s = state();
    recordStep(s, step({ confidence: 0.99, success: false }));
    const c = engine.compute(s, usage());
    expect(c.toolSuccess).toBe(0);
  });

  it('budget headroom tracks the tighter of cost and tokens', () => {
    const s = state();
    const c = engine.compute(s, usage({ costUsd: 0.09, costRemaining: 0.01 }));
    expect(c.budgetHeadroom).toBeCloseTo(0.1, 2);
  });
});

describe('RuleBasedEscalationPolicy', () => {
  const policy = new RuleBasedEscalationPolicy();

  it('continues when the last step succeeded', () => {
    const s = state();
    recordStep(s, step({}));
    expect(policy.evaluate(input(s)).action).toBe('continue');
  });

  it('continues after a single failure (the SLM gets one retry)', () => {
    const s = state();
    recordStep(s, step({ success: false }));
    recordFailure(s, { toolName: 'tool', message: 'x', kind: 'tool_error' });
    expect(policy.evaluate(input(s)).action).toBe('continue');
  });

  it('consults on the second identical failure and hands off on the third failure', () => {
    const s = state();
    for (let i = 0; i < 2; i++) {
      recordStep(s, step({ stepIndex: i, success: false }));
      recordFailure(s, { toolName: 'tool', message: 'same error /tmp/a', kind: 'tool_error' });
    }
    const d = policy.evaluate(input(s));
    expect(d.action).toBe('consult');
    expect(d.reason).toContain('repeated');
    expect(d.estimatedCostUsd).toBe(0.005);

    recordStep(s, step({ stepIndex: 2, success: false }));
    recordFailure(s, { toolName: 'tool', message: 'other', kind: 'tool_error' });
    expect(policy.evaluate(input(s)).action).toBe('handoff');
  });

  it('honours the agent asking for a consultation once there is evidence, not as a first move', () => {
    const s = state();
    const first = policy.evaluate(input(s, { agentRequest: 'consult' }));
    expect(first.action).toBe('continue');
    expect(first.reason).toContain('before gathering any evidence');
    recordStep(s, step({}));
    expect(policy.evaluate(input(s, { agentRequest: 'consult' })).action).toBe('consult');
  });

  it('handoff needs an LLM and an escalation unit; otherwise abort or continue', () => {
    const s = state();
    expect(policy.evaluate(input(s, { agentRequest: 'give_up', canEscalate: false })).action).toBe('abort');
    expect(policy.evaluate(input(s, { agentRequest: 'give_up', llmAvailable: false })).action).toBe('abort');
    for (let i = 0; i < 3; i++) recordFailure(s, { toolName: 'tool', message: `e${i}`, kind: 'tool_error' });
    const d = policy.evaluate(input(s, { llmAvailable: false }));
    expect(d.action).toBe('continue');
    expect(d.reason).toContain('no LLM provider');
  });

  it('consult is skipped when it is not affordable', () => {
    const s = state();
    recordStep(s, step({}));
    const d = policy.evaluate(input(s, { agentRequest: 'consult', canAfford: (n) => n.costUsd === undefined }));
    expect(d.action).toBe('continue');
    expect(d.reason).toContain('not affordable');
  });

  it('slm-only and llm-only never escalate', () => {
    for (const mode of ['slm-only', 'llm-only'] as const) {
      const s = state(mode, mode === 'llm-only' ? ModelTier.LLM : ModelTier.SLM);
      recordStep(s, step({}));
      expect(policy.evaluate(input(s, { agentRequest: 'consult' })).action).toBe('continue');
      expect(policy.evaluate(input(s, { agentRequest: 'give_up' })).action).toBe('abort');
    }
  });

  it('after a handoff the LLM tier does not consult, and aborts only after a second failure wave', () => {
    const s = state('adaptive', ModelTier.LLM);
    s.handoffs = 1;
    s.handoffAtStep = 3;
    s.step = 4;
    recordStep(s, step({}));
    expect(policy.evaluate(input(s, { agentRequest: 'consult' })).action).toBe('continue');
    for (let i = 0; i < 3; i++) recordFailure(s, { toolName: 'tool', message: `e${i}`, kind: 'tool_error', step: 4 + i });
    expect(policy.evaluate(input(s)).action).toBe('abort');
  });

  it('after a handoff to a middle rung, the inherited failures do not trigger the next handoff', () => {
    const s = state('adaptive', ModelTier.MID);
    for (let i = 0; i < 3; i++) recordFailure(s, { toolName: 'tool', message: `slm failure ${i}`, kind: 'tool_error', step: i });
    s.handoffs = 1;
    s.handoffAtStep = 2;
    s.step = 3;
    // The middle rung's first step succeeds: it must be allowed to keep working.
    recordStep(s, step({ stepIndex: 3, success: true, verified: true }));
    const d = policy.evaluate(input(s, { atTopRung: false }));
    expect(d.action).toBe('continue');
    // Its own failure wave, however, still escalates.
    for (let i = 0; i < 3; i++) recordFailure(s, { toolName: 'tool', message: `mid failure ${i}`, kind: 'tool_error', step: 4 + i });
    s.step = 7;
    expect(policy.evaluate(input(s, { atTopRung: false })).action).toBe('handoff');
  });

  it('a test run that repeats the previous verified result is not a second failure', () => {
    const s = state();
    // write (verified 3/12) then run tests (3/12 again), three times over with rising scores.
    const scores = [0.25, 0.5, 0.75];
    let idx = 0;
    for (const score of scores) {
      recordStep(s, step({ stepIndex: idx, toolName: 'file_write', success: true, verified: false, verifyScore: score }));
      recordFailure(s, { toolName: 'file_write', message: `verification: ${score * 12}/12 tests passed`, kind: 'verification_failed', step: idx });
      idx++;
      recordStep(s, step({ stepIndex: idx, toolName: 'shell_exec', success: true, verified: false, verifyScore: score }));
      recordFailure(s, { toolName: 'shell_exec', message: `verification: ${score * 12}/12 tests passed`, kind: 'verification_failed', step: idx });
      idx++;
      s.step = idx;
      expect(policy.evaluate(input(s)).action).toBe('continue');
    }
  });

  it('failures spread over a long, progressing run do not add up to a handoff', () => {
    const s = state();
    // 20 steps: a failure every 5 steps, successes between — four failures in total, never three within the window.
    for (let i = 0; i < 20; i++) {
      const fail = i % 5 === 4;
      recordStep(s, step({ stepIndex: i, success: !fail, verified: fail ? undefined : true }));
      if (fail) recordFailure(s, { toolName: 'tool', message: `error ${i}`, kind: 'tool_error', step: i });
      s.step = i + 1;
      expect(policy.evaluate(input(s)).action).toBe('continue');
    }
    // Three failures in the last four steps: stuck.
    for (let i = 20; i < 23; i++) {
      recordStep(s, step({ stepIndex: i, success: false }));
      recordFailure(s, { toolName: 'tool', message: `error ${i}`, kind: 'tool_error', step: i });
      s.step = i + 1;
    }
    expect(policy.evaluate(input(s)).action).toBe('handoff');
  });

  it('aborts on impossible tool requirements and when tokens for another turn are gone', () => {
    const s = state();
    recordFailure(s, { toolName: 'nope', message: 'Tool not found: nope', kind: 'missing_tool' });
    recordFailure(s, { toolName: 'nope', message: 'Tool not found: nope', kind: 'missing_tool' });
    expect(policy.evaluate(input(s)).action).toBe('abort');
    const s2 = state();
    expect(policy.evaluate(input(s2, { canAfford: () => false })).action).toBe('abort');
  });

  it('gives the agent one verification retry, then consults only without improvement', () => {
    const s = state();
    recordStep(s, step({ stepIndex: 0, success: true, verified: false, verifyScore: 0.2 }));
    recordFailure(s, { toolName: 'shell_exec', message: 'verification: 1/5 tests passed', kind: 'verification_failed' });
    expect(policy.evaluate(input(s)).action).toBe('continue');

    // Second failure but more tests pass: progress, keep going.
    recordStep(s, step({ stepIndex: 1, success: true, verified: false, verifyScore: 0.6 }));
    recordFailure(s, { toolName: 'shell_exec', message: 'verification: 3/5 tests passed', kind: 'verification_failed' });
    expect(policy.evaluate(input(s)).action).toBe('continue');

    // Third failure with no improvement: consult.
    recordStep(s, step({ stepIndex: 2, success: true, verified: false, verifyScore: 0.6 }));
    recordFailure(s, { toolName: 'shell_exec', message: 'verification: 3/5 tests passed', kind: 'verification_failed' });
    const d = policy.evaluate(input(s));
    expect(['consult', 'handoff']).toContain(d.action);
  });

  it('incremental progress (rising pass fraction across test runs) does not count toward the failure limit', () => {
    const s = state();
    // write, test 3/12, write, test 6/12, write, test 9/12: three "failed" verifications, all progress.
    const scores = [0.25, 0.5, 0.75];
    for (let i = 0; i < 3; i++) {
      recordStep(s, step({ stepIndex: 2 * i, toolName: 'file_write' }));
      recordStep(s, step({ stepIndex: 2 * i + 1, toolName: 'shell_exec', success: true, verified: false, verifyScore: scores[i] }));
      recordFailure(s, { toolName: 'shell_exec', message: `verification: ${scores[i] * 12}/12 tests passed`, kind: 'verification_failed', step: 2 * i + 1 });
      s.step = 2 * i + 2;
      expect(policy.evaluate(input(s)).action).toBe('continue');
    }
    // Another attempt (a write, then tests) that stays at 9/12 is no longer progress.
    recordStep(s, step({ stepIndex: 6, toolName: 'file_write' }));
    recordStep(s, step({ stepIndex: 7, toolName: 'shell_exec', success: true, verified: false, verifyScore: 0.75 }));
    recordFailure(s, { toolName: 'shell_exec', message: 'verification: 9/12 tests passed', kind: 'verification_failed', step: 7 });
    s.step = 8;
    expect(['consult', 'handoff']).toContain(policy.evaluate(input(s)).action);
  });

  it('parses pass fractions from test output', async () => {
    const { parsePassFraction } = await import('../src/adaptive/verifier.js');
    expect(parsePassFraction('3/5 tests passed')).toBeCloseTo(0.6);
    expect(parsePassFraction('2 failed, 8 passed in 0.3s')).toBeCloseTo(0.8);
    expect(parsePassFraction('12 passed')).toBe(1);
    expect(parsePassFraction('AssertionError')).toBeUndefined();
  });

  it('respects config overrides', () => {
    const strict = new RuleBasedEscalationPolicy({ maxFailuresBeforeHandoff: 1 });
    const s = state();
    recordStep(s, step({ success: false }));
    recordFailure(s, { toolName: 'tool', message: 'x', kind: 'tool_error' });
    expect(strict.evaluate(input(s)).action).toBe('handoff');
  });
});

describe('ExecutionState helpers', () => {
  it('versions plans instead of splicing and dedupes unchanged plans', () => {
    const s = state();
    expect(pushPlan(s, ['a', 'b'], 'agent')).toBe(true);
    expect(pushPlan(s, ['a', 'b'], 'agent')).toBe(false);
    s.step = 3;
    expect(pushPlan(s, ['b', 'c'], 'consult')).toBe(true);
    expect(s.planVersions).toHaveLength(2);
    expect(s.planVersions[1]).toMatchObject({ version: 2, step: 3, source: 'consult' });
  });

  it('counts repeated failures by normalized signature', () => {
    const s = state();
    recordFailure(s, { toolName: 'http_fetch', message: 'timeout after 30000ms for https://a.example/x/1', kind: 'tool_error' });
    recordFailure(s, { toolName: 'http_fetch', message: 'timeout after 45000ms for https://a.example/y/2', kind: 'tool_error' });
    expect(maxRepeatedFailure(s)).toBe(2);
    expect(normalizeErrorSignature('Error at C:\\Users\\me\\x.ts 2025-01-01T00:00:00Z id 123456')).toBe('error at <path> <timestamp> id <num>');
  });

  it('builds a handoff context that carries the work, failures and advice', () => {
    const s = state();
    pushPlan(s, ['inspect', 'fix', 'test'], 'agent');
    recordStep(s, step({ description: 'inspect files', output: { files: 3 } }));
    recordFailure(s, { toolName: 'shell_exec', message: 'tests failed', kind: 'verification_failed' });
    s.advice.push({ consultId: 'c1', step: 1, question: 'q?', answer: 'do y', model: 'llm', tokens: 10, costUsd: 0.001 });
    const ctx = toHandoffContext(s, ['is the lock reentrant?']);
    expect(ctx.completedWork).toHaveLength(1);
    expect(ctx.failures[0].toolName).toBe('shell_exec');
    expect(ctx.recommendedNextSteps).toEqual(['fix', 'test']);
    const text = renderHandoff(ctx);
    expect(text).toContain('COMPLETED WORK');
    expect(text).toContain('inspect files');
    expect(text).toContain('UNRESOLVED');
    expect(text).toContain('do y');
  });
});

describe('StepAgent.parseAction', () => {
  it('parses the action format', () => {
    const a = StepAgent.parseAction('{"action":"tool_call","toolName":"x","toolArgs":{"a":1},"plan":["p1"],"verify":{"type":"command_exit","command":"npm test"}}');
    expect(a.type).toBe('tool_call');
    if (a.type === 'tool_call') {
      expect(a.toolArgs).toEqual({ a: 1 });
      expect(a.plan).toEqual(['p1']);
      expect(a.verify?.type).toBe('command_exit');
    }
  });

  it('accepts DirectExecutor-style shapes and code fences', () => {
    expect(StepAgent.parseAction('```json\n{"tool_calls":[{"toolName":"y","toolArgs":{}}]}\n```').type).toBe('tool_call');
    expect(StepAgent.parseAction('{"answer":"42"}')).toEqual({ type: 'final_answer', answer: '42', plan: undefined });
    expect(StepAgent.parseAction('{"action":"give_up","reason":"no tool"}').type).toBe('give_up');
  });

  it('repairs raw newlines inside JSON string values (common with small models writing code)', () => {
    const a = StepAgent.parseAction('{"action":"tool_call","toolName":"file_write","toolArgs":{"path":"s.py","content":"def f(x):\n    return x\n"}}');
    expect(a.type).toBe('tool_call');
    if (a.type === 'tool_call') expect(a.toolArgs.content).toBe('def f(x):\n    return x\n');
  });

  it('flags prose as malformed instead of treating it as an answer', () => {
    expect(StepAgent.parseAction('Let me look at the files first.').type).toBe('malformed');
    expect(StepAgent.parseAction('{"unknown": true}').type).toBe('malformed');
  });
});

describe('Budget and trace additions', () => {
  it('canAfford checks cost and tokens continuously', () => {
    const bm = new BudgetManager();
    const env = bm.createEnvelope({ maxTokens: 1000, costCeilingUsd: 0.01, maxLatencyMs: 10_000, maxToolCalls: 5, maxEscalations: 1 });
    expect(bm.canAfford(env, { costUsd: 0.005 })).toBe(true);
    expect(bm.canAfford(env, { costUsd: 0.02 })).toBe(false);
    expect(bm.canAfford(env, { tokens: 2000 })).toBe(false);
  });

  it('recordModelResponse charges the provider cost once, or the pricing table when absent', () => {
    const bm = new BudgetManager();
    const env = bm.createEnvelope('high');
    const base = { provider: 'openai' as const, tier: ModelTier.SLM, content: '', tokenUsage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 }, latencyMs: 1, finishReason: 'stop' as const };
    const a = bm.recordModelResponse(env, { ...base, model: 'gpt-4o-mini', costUsd: 0.002 });
    expect(a.costUsd).toBe(0.002);
    const b = bm.recordModelResponse(env, { ...base, model: 'gpt-4o-mini', costUsd: 0 });
    expect(b.costUsd).toBeCloseTo(0.000375, 6);
    expect(bm.getUsage(env).tokensUsed).toBe(2000);
    expect(bm.getUsage(env).costUsd).toBeCloseTo(0.002375, 6);
  });

  it('computeTierUsage splits model_call events by tier', () => {
    const ev = (tier: string, totalTokens: number, costUsd: number) => ({
      id: 'e', traceId: 't', type: 'model_call' as const, timestamp: 0, wallClock: '', data: { tier, totalTokens, costUsd },
    });
    const usage = computeTierUsage([{
      id: 's', traceId: 't', name: 'root', startTime: 0, events: [ev('slm', 100, 0.001), ev('llm', 50, 0.01)],
      children: [{ id: 'c', traceId: 't', name: 'child', startTime: 0, events: [ev('slm', 20, 0.0002)], children: [] }],
    }]);
    expect(usage).toEqual({ slmTokens: 120, midTokens: 0, llmTokens: 50, slmCostUsd: 0.0012, midCostUsd: 0, llmCostUsd: 0.01, slmCalls: 2, midCalls: 0, llmCalls: 1 });
  });
});
