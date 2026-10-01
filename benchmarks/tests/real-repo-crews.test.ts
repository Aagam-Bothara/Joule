import { describe, expect, it } from 'vitest';
import { REAL_REPO_BUDGET, sweCrew } from '../real-repo/crews.js';
import { comparisonCrew } from '../specialist-value/crews.js';

describe('real-repo crew budget', () => {
  it('gives every real-repo arm 400k tokens per agent', () => {
    for (const arm of ['primary', 'full', 'full_verify', 'staged'] as const) {
      const crew = sweCrew(arm);
      expect(crew.budget).toEqual(REAL_REPO_BUDGET);
      expect(crew.budgetMode).toBe('fixed_per_agent');
    }
    expect(REAL_REPO_BUDGET.maxTokens).toBe(400_000);
  });

  it('scales the other limits so tokens stay the binding one', () => {
    // Four times the `high` preset (40 tool calls, 0.5 Wh, 0.2 g), $1 cost kept.
    expect(REAL_REPO_BUDGET.maxToolCalls).toBe(160);
    expect(REAL_REPO_BUDGET.maxLatencyMs).toBe(600_000);
    expect(REAL_REPO_BUDGET.costCeilingUsd).toBe(1);
  });

  it('leaves the authored benchmark on the high preset', () => {
    expect(comparisonCrew('staged').budget).toBe('high');
  });
});
