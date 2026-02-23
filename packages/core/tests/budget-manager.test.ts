import { describe, it, expect } from 'vitest';
import { BudgetManager } from '../src/budget-manager.js';
import { BudgetExhaustedError } from '@joule/shared';

describe('BudgetManager', () => {
  it('creates envelope with preset name', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('low');
    expect(env.envelope.maxTokens).toBe(4_000);
    expect(env.envelope.maxEscalations).toBe(0);
    expect(env.envelope.costCeilingUsd).toBe(0.01);
  });

  it('creates envelope with custom overrides', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope({ maxTokens: 500, maxToolCalls: 1 });
    expect(env.envelope.maxTokens).toBe(500);
    expect(env.envelope.maxToolCalls).toBe(1);
    // Other fields default to medium
    expect(env.envelope.maxLatencyMs).toBe(30_000);
  });

  it('defaults to medium when no budget specified', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope();
    expect(env.envelope.maxTokens).toBe(16_000);
  });

  it('tracks token deductions', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('low');
    mgr.deductTokens(env, 1000, 'llama3.2:3b');
    const usage = mgr.getUsage(env);
    expect(usage.tokensUsed).toBe(1000);
    expect(usage.tokensRemaining).toBe(3000);
  });

  it('tracks tool call deductions', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('low');
    mgr.deductToolCall(env);
    mgr.deductToolCall(env);
    const usage = mgr.getUsage(env);
    expect(usage.toolCallsUsed).toBe(2);
    expect(usage.toolCallsRemaining).toBe(1);
  });

  it('throws BudgetExhaustedError when tokens exceeded', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope({ maxTokens: 100 });
    mgr.deductTokens(env, 200, 'llama3.2:3b');
    expect(() => mgr.checkBudget(env)).toThrow(BudgetExhaustedError);
  });

  it('throws BudgetExhaustedError when tool calls exceeded', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope({ maxToolCalls: 1 });
    mgr.deductToolCall(env);
    mgr.deductToolCall(env);
    expect(() => mgr.checkBudget(env)).toThrow(BudgetExhaustedError);
  });

  it('reports canAffordEscalation correctly', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('low'); // maxEscalations: 0
    expect(mgr.canAffordEscalation(env)).toBe(false);

    const env2 = mgr.createEnvelope('medium'); // maxEscalations: 1
    expect(mgr.canAffordEscalation(env2)).toBe(true);
    mgr.deductEscalation(env2);
    expect(mgr.canAffordEscalation(env2)).toBe(false);
  });

  it('creates budget checkpoints', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('medium');
    mgr.deductTokens(env, 500, 'llama3.2:3b');
    const checkpoint = mgr.checkpoint(env, 'after-classify');
    expect(checkpoint.label).toBe('after-classify');
    expect(checkpoint.usage.tokensUsed).toBe(500);
  });
});
