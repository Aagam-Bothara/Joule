import { z } from 'zod';

export const modelTierSchema = z.enum(['slm', 'llm']);

export const modelProviderNameSchema = z.enum(['ollama', 'anthropic', 'openai', 'google']);

export const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

export const modelRequestSchema = z.object({
  model: z.string(),
  provider: modelProviderNameSchema,
  tier: modelTierSchema,
  system: z.string().optional(),
  messages: z.array(chatMessageSchema).min(1),
  maxTokens: z.number().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  responseFormat: z.enum(['text', 'json']).optional(),
});

export const tokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const modelResponseSchema = z.object({
  model: z.string(),
  provider: modelProviderNameSchema,
  tier: modelTierSchema,
  content: z.string(),
  tokenUsage: tokenUsageSchema,
  latencyMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).optional(),
  finishReason: z.enum(['stop', 'length', 'error']),
  energyWh: z.number().nonnegative().optional(),
  carbonGrams: z.number().nonnegative().optional(),
});
