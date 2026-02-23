import { z } from 'zod';

export const budgetEnvelopeSchema = z.object({
  maxTokens: z.number().positive(),
  maxLatencyMs: z.number().positive(),
  maxToolCalls: z.number().int().nonnegative(),
  maxEscalations: z.number().int().nonnegative(),
  costCeilingUsd: z.number().nonnegative(),
  maxEnergyWh: z.number().positive().optional(),
  maxCarbonGrams: z.number().positive().optional(),
});

export const budgetPresetNameSchema = z.enum(['low', 'medium', 'high', 'unlimited']);

export const budgetUsageSchema = z.object({
  tokensUsed: z.number().nonnegative(),
  tokensRemaining: z.number(),
  toolCallsUsed: z.number().int().nonnegative(),
  toolCallsRemaining: z.number().int(),
  escalationsUsed: z.number().int().nonnegative(),
  escalationsRemaining: z.number().int(),
  costUsd: z.number().nonnegative(),
  costRemaining: z.number(),
  elapsedMs: z.number().nonnegative(),
  latencyRemaining: z.number(),
  energyWh: z.number().nonnegative().optional(),
  energyRemaining: z.number().optional(),
  carbonGrams: z.number().nonnegative().optional(),
  carbonRemaining: z.number().optional(),
});
