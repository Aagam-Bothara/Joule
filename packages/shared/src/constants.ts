import type { BudgetEnvelope, BudgetPresetName } from './types/budget.js';
import type { JouleConfig } from './types/config.js';
import type { ModelEnergyProfile, EnergyConfig } from './types/energy.js';

export const BUDGET_PRESETS: Record<BudgetPresetName, BudgetEnvelope> = {
  low: {
    maxTokens: 4_000,
    maxLatencyMs: 10_000,
    maxToolCalls: 3,
    maxEscalations: 0,
    costCeilingUsd: 0.01,
    maxEnergyWh: 0.005,
    maxCarbonGrams: 0.002,
  },
  medium: {
    maxTokens: 16_000,
    maxLatencyMs: 30_000,
    maxToolCalls: 10,
    maxEscalations: 1,
    costCeilingUsd: 0.10,
    maxEnergyWh: 0.05,
    maxCarbonGrams: 0.02,
  },
  high: {
    maxTokens: 100_000,
    maxLatencyMs: 300_000,
    maxToolCalls: 40,
    maxEscalations: 5,
    costCeilingUsd: 1.00,
    maxEnergyWh: 0.5,
    maxCarbonGrams: 0.2,
  },
  unlimited: {
    maxTokens: Infinity,
    maxLatencyMs: 600_000,
    maxToolCalls: 100,
    maxEscalations: 10,
    costCeilingUsd: 10.00,
  },
};

export const MODEL_PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  // Anthropic
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.80, outputPerMillion: 4.00 },
  'claude-sonnet-4-20250514': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'claude-opus-4-20250514': { inputPerMillion: 15.00, outputPerMillion: 75.00 },
  // OpenAI
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  // Google
  'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'gemini-2.5-flash': { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
  // OpenRouter ids (USD per million, approximate list prices)
  'meta-llama/llama-3.1-8b-instruct': { inputPerMillion: 0.02, outputPerMillion: 0.05 },
  'meta-llama/llama-3.3-70b-instruct': { inputPerMillion: 0.10, outputPerMillion: 0.30 },
  'openai/gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  'openai/gpt-4o': { inputPerMillion: 2.50, outputPerMillion: 10.00 },
  'anthropic/claude-sonnet-4': { inputPerMillion: 3.00, outputPerMillion: 15.00 },
  'google/gemini-2.5-flash': { inputPerMillion: 0.30, outputPerMillion: 2.50 },
  'google/gemini-2.5-flash-lite': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
  'anthropic/claude-haiku-4.5': { inputPerMillion: 1.00, outputPerMillion: 5.00 },
  'qwen/qwen-2.5-7b-instruct': { inputPerMillion: 0.04, outputPerMillion: 0.10 },
  'qwen/qwen3-8b': { inputPerMillion: 0.035, outputPerMillion: 0.14 },
  'deepseek/deepseek-chat': { inputPerMillion: 0.25, outputPerMillion: 0.85 },
  'meta-llama/llama-3.2-3b-instruct': { inputPerMillion: 0.015, outputPerMillion: 0.025 },
  // Ollama (local = free)
  'llama3.2:3b': { inputPerMillion: 0, outputPerMillion: 0 },
  'llama3.2:1b': { inputPerMillion: 0, outputPerMillion: 0 },
  'phi-3:mini': { inputPerMillion: 0, outputPerMillion: 0 },
  'mistral:7b': { inputPerMillion: 0, outputPerMillion: 0 },
  'qwen2.5:7b': { inputPerMillion: 0, outputPerMillion: 0 },
};

export const MODEL_ENERGY: Record<string, ModelEnergyProfile> = {
  // Anthropic (cloud GPU inference)
  'claude-haiku-4-5-20251001':          { inputWhPerMillion: 0.4, outputWhPerMillion: 1.5, source: 'estimated' },
  'claude-sonnet-4-20250514':  { inputWhPerMillion: 1.2, outputWhPerMillion: 4.5, source: 'estimated' },
  'claude-opus-4-20250514':    { inputWhPerMillion: 3.5, outputWhPerMillion: 12.0, source: 'estimated' },
  // OpenAI (cloud GPU inference)
  'gpt-4o-mini':              { inputWhPerMillion: 0.3, outputWhPerMillion: 1.2, source: 'estimated' },
  'gpt-4o':                   { inputWhPerMillion: 1.5, outputWhPerMillion: 5.0, source: 'estimated' },
  // Google (cloud TPU inference)
  'gemini-2.0-flash':         { inputWhPerMillion: 0.2, outputWhPerMillion: 0.8, source: 'estimated' },
  'gemini-2.5-flash':         { inputWhPerMillion: 0.25, outputWhPerMillion: 1.0, source: 'estimated' },
  'gemini-2.5-pro':           { inputWhPerMillion: 1.0, outputWhPerMillion: 3.5, source: 'estimated' },
  // OpenRouter ids (cloud, estimated)
  'meta-llama/llama-3.1-8b-instruct': { inputWhPerMillion: 0.15, outputWhPerMillion: 0.6, source: 'estimated' },
  'meta-llama/llama-3.3-70b-instruct': { inputWhPerMillion: 0.8, outputWhPerMillion: 3.0, source: 'estimated' },
  'openai/gpt-4o-mini': { inputWhPerMillion: 0.3, outputWhPerMillion: 1.2, source: 'estimated' },
  'openai/gpt-4o': { inputWhPerMillion: 1.5, outputWhPerMillion: 5.0, source: 'estimated' },
  'anthropic/claude-sonnet-4': { inputWhPerMillion: 1.2, outputWhPerMillion: 4.5, source: 'estimated' },
  'google/gemini-2.5-flash': { inputWhPerMillion: 0.25, outputWhPerMillion: 1.0, source: 'estimated' },
  // Ollama local (user's hardware — energy tracked but carbon = 0 by default)
  'llama3.2:3b':              { inputWhPerMillion: 0.15, outputWhPerMillion: 0.6, source: 'zero' },
  'llama3.2:1b':              { inputWhPerMillion: 0.08, outputWhPerMillion: 0.3, source: 'zero' },
  'phi-3:mini':               { inputWhPerMillion: 0.10, outputWhPerMillion: 0.4, source: 'zero' },
  'mistral:7b':               { inputWhPerMillion: 0.25, outputWhPerMillion: 1.0, source: 'zero' },
  'qwen2.5:7b':               { inputWhPerMillion: 0.25, outputWhPerMillion: 1.0, source: 'zero' },
};

export const DEFAULT_ENERGY_CONFIG: EnergyConfig = {
  enabled: true,
  gridCarbonIntensity: 400,
  localModelCarbonIntensity: 0,
  includeInRouting: false,
  energyWeight: 0.3,
};

export const DEFAULT_CONFIG: JouleConfig = {
  providers: {
    ollama: {
      baseUrl: 'http://localhost:11434',
      models: { slm: 'llama3.2:3b' },
      enabled: true,
    },
  },
  budgets: {
    default: 'medium',
    presets: BUDGET_PRESETS,
  },
  tools: {
    builtinEnabled: true,
    pluginDirs: [],
    disabledTools: [],
  },
  routing: {
    preferLocal: true,
    slmConfidenceThreshold: 0.6,
    complexityThreshold: 0.7,
    providerPriority: {
      slm: ['ollama', 'google', 'openai', 'anthropic'],
      llm: ['anthropic', 'openai', 'google'],
    },
    maxReplanDepth: 2,
  },
  logging: {
    level: 'info',
    traceOutput: 'memory',
  },
  server: {
    port: 3927,
    host: '127.0.0.1',
  },
  energy: DEFAULT_ENERGY_CONFIG,
};
