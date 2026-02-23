import { describe, it, expect } from 'vitest';
import { getModelCost, estimateModelCost, getModelEnergy, estimateModelEnergy } from '../src/pricing.js';

describe('Pricing', () => {
  it('calculates cost for known model', () => {
    const cost = getModelCost('gpt-4o', { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });
    // gpt-4o: input=$2.50/M, output=$10.00/M
    // cost = (1M * 2.5 + 1M * 10.0) / 1M = $12.50
    expect(cost).toBeCloseTo(12.50, 2);
  });

  it('returns 0 cost for unknown model', () => {
    const cost = getModelCost('unknown-model', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    expect(cost).toBe(0);
  });

  it('estimates cost for prompt tokens', () => {
    const est = estimateModelCost('gpt-4o', 1000);
    // Assumes input = output for estimation: (1000 * 2.5 + 1000 * 10.0) / 1M = 0.0125
    expect(est).toBeCloseTo(0.0125, 6);
  });
});

describe('Energy', () => {
  it('calculates energy for known model', () => {
    const energy = getModelEnergy('gpt-4o', { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 });
    // gpt-4o: input=1.5 Wh/M, output=5.0 Wh/M
    // energy = (1M * 1.5 + 1M * 5.0) / 1M = 6.5 Wh
    expect(energy).toBeCloseTo(6.5, 4);
  });

  it('returns 0 energy for unknown model', () => {
    const energy = getModelEnergy('unknown-model', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    expect(energy).toBe(0);
  });

  it('estimates energy for prompt tokens', () => {
    const est = estimateModelEnergy('gpt-4o', 1000);
    // (1000 * (1.5 + 5.0)) / 1M = 0.0065 Wh
    expect(est).toBeCloseTo(0.0065, 6);
  });
});
