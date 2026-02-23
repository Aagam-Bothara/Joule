import { z } from 'zod';

export const modelEnergyProfileSchema = z.object({
  inputWhPerMillion: z.number().nonnegative(),
  outputWhPerMillion: z.number().nonnegative(),
  source: z.enum(['measured', 'estimated', 'zero']),
});

export const energyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  gridCarbonIntensity: z.number().positive().default(400),
  localModelCarbonIntensity: z.number().nonnegative().default(0),
  includeInRouting: z.boolean().default(false),
  energyWeight: z.number().min(0).max(1).default(0.3),
});

export const efficiencyReportSchema = z.object({
  actualEnergyWh: z.number().nonnegative(),
  actualCarbonGrams: z.number().nonnegative(),
  baselineEnergyWh: z.number().nonnegative(),
  baselineCarbonGrams: z.number().nonnegative(),
  savedEnergyWh: z.number(),
  savedCarbonGrams: z.number(),
  savingsPercent: z.number(),
  baselineModel: z.string(),
});
