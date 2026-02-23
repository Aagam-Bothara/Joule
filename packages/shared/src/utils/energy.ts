import type { TokenUsage } from '../types/model.js';
import type { EnergyConfig, EfficiencyReport } from '../types/energy.js';
import { MODEL_ENERGY } from '../constants.js';

export function calculateEnergy(
  model: string,
  usage: TokenUsage,
): number {
  const profile = MODEL_ENERGY[model];
  if (!profile) return 0;
  return (
    (usage.promptTokens * profile.inputWhPerMillion +
      usage.completionTokens * profile.outputWhPerMillion) /
    1_000_000
  );
}

export function estimateEnergy(
  model: string,
  estimatedPromptTokens: number,
  estimatedCompletionTokens: number,
): number {
  const profile = MODEL_ENERGY[model];
  if (!profile) return 0;
  return (
    (estimatedPromptTokens * profile.inputWhPerMillion +
      estimatedCompletionTokens * profile.outputWhPerMillion) /
    1_000_000
  );
}

export function calculateCarbon(
  energyWh: number,
  model: string,
  config: EnergyConfig,
): number {
  const profile = MODEL_ENERGY[model];
  const intensity = profile?.source === 'zero'
    ? config.localModelCarbonIntensity
    : config.gridCarbonIntensity;
  return (energyWh / 1000) * intensity;
}

export function getEnergyEfficiency(model: string): number {
  const profile = MODEL_ENERGY[model];
  if (!profile) return Infinity;
  return (profile.inputWhPerMillion + profile.outputWhPerMillion) / 2;
}

export function buildEfficiencyReport(
  actualEnergyWh: number,
  actualCarbonGrams: number,
  totalInputTokens: number,
  totalOutputTokens: number,
  baselineModel: string,
  config: EnergyConfig,
): EfficiencyReport {
  const baselineEnergyWh = estimateEnergy(
    baselineModel,
    totalInputTokens,
    totalOutputTokens,
  );
  const baselineCarbonGrams = calculateCarbon(
    baselineEnergyWh,
    baselineModel,
    config,
  );
  const savedEnergyWh = baselineEnergyWh - actualEnergyWh;
  const savedCarbonGrams = baselineCarbonGrams - actualCarbonGrams;
  const savingsPercent = baselineEnergyWh > 0
    ? (savedEnergyWh / baselineEnergyWh) * 100
    : 0;

  return {
    actualEnergyWh,
    actualCarbonGrams,
    baselineEnergyWh,
    baselineCarbonGrams,
    savedEnergyWh,
    savedCarbonGrams,
    savingsPercent,
    baselineModel,
  };
}
