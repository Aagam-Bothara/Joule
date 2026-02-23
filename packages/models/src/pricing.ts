import { MODEL_PRICING, MODEL_ENERGY } from '@joule/shared';
import type { TokenUsage } from '@joule/shared';

export function getModelCost(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (usage.promptTokens * pricing.inputPerMillion +
      usage.completionTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

export function estimateModelCost(
  model: string,
  estimatedPromptTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  // Assume output is roughly equal to input for estimation
  return (
    (estimatedPromptTokens * pricing.inputPerMillion +
      estimatedPromptTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

export function getModelEnergy(model: string, usage: TokenUsage): number {
  const profile = MODEL_ENERGY[model];
  if (!profile) return 0;
  return (
    (usage.promptTokens * profile.inputWhPerMillion +
      usage.completionTokens * profile.outputWhPerMillion) /
    1_000_000
  );
}

export function estimateModelEnergy(model: string, estimatedPromptTokens: number): number {
  const profile = MODEL_ENERGY[model];
  if (!profile) return 0;
  return (
    (estimatedPromptTokens * (profile.inputWhPerMillion + profile.outputWhPerMillion)) /
    1_000_000
  );
}
