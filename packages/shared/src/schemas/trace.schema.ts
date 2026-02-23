import { z } from 'zod';

export const traceEventTypeSchema = z.enum([
  'model_call',
  'tool_call',
  'routing_decision',
  'budget_checkpoint',
  'escalation',
  'plan_generated',
  'replan',
  'error',
  'info',
  'energy_report',
]);

export const traceEventSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().optional(),
  type: traceEventTypeSchema,
  timestamp: z.number(),
  wallClock: z.string(),
  duration: z.number().optional(),
  data: z.record(z.unknown()),
});
