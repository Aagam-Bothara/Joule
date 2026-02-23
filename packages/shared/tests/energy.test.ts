import { describe, it, expect } from 'vitest';
import { calculateEnergy, estimateEnergy, calculateCarbon, getEnergyEfficiency, buildEfficiencyReport } from '../src/utils/energy.js';
import type { EnergyConfig } from '../src/types/energy.js';

const defaultEnergyConfig: EnergyConfig = {
  enabled: true,
  gridCarbonIntensity: 400,
  localModelCarbonIntensity: 0,
  includeInRouting: false,
  energyWeight: 0.3,
};

describe('Energy utilities', () => {
  it('calculateEnergy returns correct Wh for known model', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    const energy = calculateEnergy('gpt-4o', usage);
    // gpt-4o: input 1.5 Wh/M, output 5.0 Wh/M
    expect(energy).toBeCloseTo(1.5 + 5.0, 5);
  });

  it('calculateEnergy returns 0 for unknown model', () => {
    const usage = { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 };
    const energy = calculateEnergy('unknown-model', usage);
    expect(energy).toBe(0);
  });

  it('calculateCarbon uses grid intensity for cloud models', () => {
    const energyWh = 1.0;
    const carbon = calculateCarbon(energyWh, 'gpt-4o', defaultEnergyConfig);
    // 1 Wh = 0.001 kWh, * 400 gCO2/kWh = 0.4 g
    expect(carbon).toBeCloseTo(0.4, 5);
  });

  it('calculateCarbon uses zero intensity for local models', () => {
    const energyWh = 1.0;
    const carbon = calculateCarbon(energyWh, 'llama3.2:3b', defaultEnergyConfig);
    // Local models use localModelCarbonIntensity = 0
    expect(carbon).toBe(0);
  });

  it('getEnergyEfficiency ranks models correctly', () => {
    const flashEfficiency = getEnergyEfficiency('gemini-2.0-flash');
    const gpt4oEfficiency = getEnergyEfficiency('gpt-4o');
    const unknownEfficiency = getEnergyEfficiency('unknown');
    // Flash should be more efficient (lower number) than GPT-4o
    expect(flashEfficiency).toBeLessThan(gpt4oEfficiency);
    expect(unknownEfficiency).toBe(Infinity);
  });

  it('buildEfficiencyReport produces correct savings', () => {
    const report = buildEfficiencyReport(
      0.5,    // actual energy Wh
      0.1,    // actual carbon grams
      1_000_000,  // input tokens
      1_000_000,  // output tokens
      'gpt-4o',   // baseline
      defaultEnergyConfig,
    );
    // Baseline: 1.5 + 5.0 = 6.5 Wh
    expect(report.baselineEnergyWh).toBeCloseTo(6.5, 5);
    expect(report.savedEnergyWh).toBeCloseTo(6.0, 5);
    expect(report.savingsPercent).toBeGreaterThan(90);
    expect(report.baselineModel).toBe('gpt-4o');
  });
});
