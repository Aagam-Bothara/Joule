import type { TokenUsage } from '../types/model.js';
import { MODEL_PRICING } from '../constants.js';

export function calculateCost(
  model: string,
  usage: TokenUsage,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (usage.promptTokens * pricing.inputPerMillion +
      usage.completionTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

export function estimateCost(
  model: string,
  estimatedPromptTokens: number,
  estimatedCompletionTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (estimatedPromptTokens * pricing.inputPerMillion +
      estimatedCompletionTokens * pricing.outputPerMillion) /
    1_000_000
  );
}
