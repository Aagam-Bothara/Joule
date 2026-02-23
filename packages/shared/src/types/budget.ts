export interface BudgetEnvelope {
  maxTokens: number;
  maxLatencyMs: number;
  maxToolCalls: number;
  maxEscalations: number;
  costCeilingUsd: number;
  maxEnergyWh?: number;
  maxCarbonGrams?: number;
}

export type BudgetPresetName = 'low' | 'medium' | 'high' | 'unlimited';

export interface BudgetUsage {
  tokensUsed: number;
  tokensRemaining: number;
  toolCallsUsed: number;
  toolCallsRemaining: number;
  escalationsUsed: number;
  escalationsRemaining: number;
  costUsd: number;
  costRemaining: number;
  elapsedMs: number;
  latencyRemaining: number;
  energyWh?: number;
  energyRemaining?: number;
  carbonGrams?: number;
  carbonRemaining?: number;
}

export interface BudgetCheckpoint {
  label: string;
  timestamp: number;
  usage: BudgetUsage;
}
