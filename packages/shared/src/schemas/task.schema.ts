import { z } from 'zod';
import { budgetPresetNameSchema, budgetEnvelopeSchema } from './budget.schema.js';

export const taskSubmissionSchema = z.object({
  description: z.string().min(1).max(10_000),
  budget: z.union([budgetPresetNameSchema, budgetEnvelopeSchema.partial()]).optional(),
  context: z.record(z.unknown()).optional(),
  tools: z.array(z.string()).optional(),
});

export const taskStatusSchema = z.enum([
  'pending',
  'planning',
  'executing',
  'synthesizing',
  'completed',
  'failed',
  'budget_exhausted',
]);
