import { describe, it, expect } from 'vitest';
import { BudgetManager } from '../src/budget-manager.js';
import { BudgetExhaustedError, type EnergyConfig } from '@joule/shared';

const testEnergyConfig: EnergyConfig = {
  enabled: true,
  gridCarbonIntensity: 400,
  localModelCarbonIntensity: 0,
  includeInRouting: false,
  energyWeight: 0.3,
};

describe('BudgetManager - Energy Tracking', () => {
  it('tracks energy deductions for cloud model', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('medium');
    mgr.deductEnergy(env, 'gpt-4o', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, testEnergyConfig);
    const usage = mgr.getUsage(env);
    // gpt-4o: input=1.5 Wh/M, output=5.0 Wh/M
    // energy = (1000 * 1.5 + 500 * 5.0) / 1_000_000 = (1500 + 2500) / 1_000_000 = 0.004 Wh
    expect(usage.energyWh).toBeCloseTo(0.004, 6);
  });

  it('tracks carbon for cloud model using grid intensity', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('medium');
    mgr.deductEnergy(env, 'gpt-4o', { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }, testEnergyConfig);
    const usage = mgr.getUsage(env);
    // energy = (1M * 1.5 + 1M * 5.0) / 1M = 6.5 Wh
    // carbon = 6.5 * 400 / 1000 = 2.6 gCO2
    expect(usage.energyWh).toBeCloseTo(6.5, 4);
    expect(usage.carbonGrams).toBeCloseTo(2.6, 4);
  });

  it('tracks zero carbon for local Ollama model', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('medium');
    mgr.deductEnergy(env, 'llama3.2:3b', { promptTokens: 10000, completionTokens: 5000, totalTokens: 15000 }, testEnergyConfig);
    const usage = mgr.getUsage(env);
    // llama3.2:3b: input=0.15 Wh/M, output=0.6 Wh/M, source='zero'
    // energy = (10000 * 0.15 + 5000 * 0.6) / 1_000_000 = (1500 + 3000) / 1_000_000 = 0.0045 Wh
    expect(usage.energyWh).toBeCloseTo(0.0045, 6);
    // carbon = 0 because localModelCarbonIntensity = 0 and source is 'zero'
    expect(usage.carbonGrams).toBe(0);
  });

  it('throws BudgetExhaustedError when energy limit exceeded', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope({ maxEnergyWh: 0.001 });
    mgr.deductEnergy(env, 'gpt-4o', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, testEnergyConfig);
    // energy = 0.004 Wh > 0.001 limit
    expect(() => mgr.checkBudget(env)).toThrow(BudgetExhaustedError);
    try {
      mgr.checkBudget(env);
    } catch (err) {
      expect((err as BudgetExhaustedError).dimension).toBe('energy');
    }
  });

  it('throws BudgetExhaustedError when carbon limit exceeded', () => {
    const mgr = new BudgetManager();
    // Set high energy limit so energy check passes, but low carbon limit
    const env = mgr.createEnvelope({ maxCarbonGrams: 0.0001, maxEnergyWh: 100 });
    mgr.deductEnergy(env, 'gpt-4o', { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }, testEnergyConfig);
    // carbon = 2.6g > 0.0001 limit, energy = 6.5 Wh < 100 limit
    expect(() => mgr.checkBudget(env)).toThrow(BudgetExhaustedError);
    try {
      mgr.checkBudget(env);
    } catch (err) {
      expect((err as BudgetExhaustedError).dimension).toBe('carbon');
    }
  });

  it('accumulates energy across multiple deductions', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope('high');
    mgr.deductEnergy(env, 'gpt-4o', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, testEnergyConfig);
    mgr.deductEnergy(env, 'llama3.2:3b', { promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 }, testEnergyConfig);
    const totals = mgr.getEnergyTotals(env);
    expect(totals.totalInputTokens).toBe(3000);
    expect(totals.totalOutputTokens).toBe(1500);
    expect(totals.energyWh).toBeGreaterThan(0);
  });

  it('reports energy remaining correctly', () => {
    const mgr = new BudgetManager();
    const env = mgr.createEnvelope({ maxEnergyWh: 1.0 });
    mgr.deductEnergy(env, 'gpt-4o', { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    const usage = mgr.getUsage(env);
    expect(usage.energyRemaining).toBeDefined();
    expect(usage.energyRemaining!).toBeCloseTo(1.0 - 0.004, 4);
  });

  it('reports undefined energy remaining when no limit set', () => {
    const mgr = new BudgetManager();
    // Explicitly clear energy/carbon limits (medium preset sets them)
    const env = mgr.createEnvelope({ maxTokens: 1000, maxEnergyWh: undefined, maxCarbonGrams: undefined });
    const usage = mgr.getUsage(env);
    expect(usage.energyRemaining).toBeUndefined();
    expect(usage.carbonRemaining).toBeUndefined();
  });
});
