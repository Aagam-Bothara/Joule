import { z } from 'zod';

export const toolInvocationSchema = z.object({
  toolName: z.string().min(1),
  input: z.unknown(),
  timeoutMs: z.number().positive().optional(),
});

export const toolResultSchema = z.object({
  toolName: z.string(),
  success: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
