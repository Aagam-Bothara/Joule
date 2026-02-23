import { z } from 'zod';

export const sessionMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  timestamp: z.string(),
});

export const sessionMetadataSchema = z.object({
  messageCount: z.number().int().min(0),
  totalCostUsd: z.number().min(0),
  totalEnergyWh: z.number().min(0),
  totalCarbonGrams: z.number().min(0),
  totalTokens: z.number().int().min(0),
});

export const chatSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(sessionMessageSchema),
  metadata: sessionMetadataSchema,
});

export const sessionListEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().min(0),
  preview: z.string(),
});
