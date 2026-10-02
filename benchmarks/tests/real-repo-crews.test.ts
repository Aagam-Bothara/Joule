import { describe, expect, it } from 'vitest';
import { REAL_REPO_BUDGET, sweCrew } from '../real-repo/crews.js';
import { comparisonCrew } from '../specialist-value/crews.js';

describe('real-repo crew allowance', () => {
  it('gives every real-repo arm the same per-agent envelope', () => {
    for (const arm of ['primary', 'full', 'full_verify', 'staged'] as const) {
      const crew = sweCrew(arm);
      expect(crew.budget).toEqual(REAL_REPO_BUDGET);
      expect(crew.budgetMode).toBe('fixed_per_agent');
    }
  });

  it('matches the escalation harness: 30 turns, 30 minutes, 1.5M tokens, 12k output per reply', () => {
    expect(REAL_REPO_BUDGET.maxTokens).toBe(1_500_000);
    expect(REAL_REPO_BUDGET.maxLatencyMs).toBe(1_800_000);
    for (const agent of sweCrew('staged').agents) {
      expect(agent.maxIterations).toBe(30);
      expect(agent.wallTimeoutMs).toBe(1_800_000);
      expect(agent.maxOutputTokens).toBe(12_000);
    }
  });

  it('keeps the $1 cost ceiling', () => {
    expect(REAL_REPO_BUDGET.costCeilingUsd).toBe(1);
  });

  it('leaves the authored benchmark on the high preset', () => {
    expect(comparisonCrew('staged').budget).toBe('high');
  });
});
