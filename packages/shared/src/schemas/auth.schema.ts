import { z } from 'zod';

export const apiKeySchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
});

export const monthlyBudgetQuotaSchema = z.object({
  maxTokens: z.number().int().min(0),
  maxCostUsd: z.number().min(0),
  maxEnergyWh: z.number().min(0),
  tokensUsed: z.number().int().min(0).default(0),
  costUsed: z.number().min(0).default(0),
  energyUsed: z.number().min(0).default(0),
  periodStart: z.string(),
});

export const userRoleSchema = z.enum(['user', 'admin']);

export const jouleUserSchema = z.object({
  id: z.string(),
  username: z.string().min(3).max(50),
  passwordHash: z.string(),
  role: userRoleSchema.default('user'),
  createdAt: z.string(),
  apiKeys: z.array(apiKeySchema).default([]),
  quota: monthlyBudgetQuotaSchema,
});

export const authConfigSchema = z.object({
  enabled: z.boolean().default(false),
  jwtSecret: z.string().min(16),
  tokenExpirySeconds: z.number().int().min(60).default(86400),
  store: z.enum(['file']).default('file'),
});

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const registerRequestSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8),
  role: userRoleSchema.optional(),
});
