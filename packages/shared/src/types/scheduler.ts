import type { BudgetPresetName } from './budget.js';

export interface ScheduledTask {
  id: string;
  name: string;
  cron: string;
  taskDescription: string;
  budgetPreset: BudgetPresetName;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: 'completed' | 'failed' | 'budget_exhausted';
  runCount: number;
  totalEnergyWh: number;
  totalCarbonGrams: number;
}

export interface ScheduleConfig {
  enabled?: boolean;
  scheduleFile?: string;
  maxConcurrent?: number;
  telemetryEnabled?: boolean;
}

export interface ScheduleRunLog {
  scheduleId: string;
  taskId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  energyWh: number;
  carbonGrams: number;
  tokensUsed: number;
}
