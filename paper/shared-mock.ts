/**
 * Shared mock provider factory for paper experiments.
 * Matches the exact interface expected by Joule's ModelProviderRegistry.
 */

import { ModelTier, generateId } from '@joule/shared';
import type { Task } from '@joule/shared';

export { ModelTier, generateId, type Task };

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface MockConfig {
  slmLatency?: number;
  llmLatency?: number;
  slmCostPerCall?: number;
  llmCostPerCall?: number;
  slmTokens?: number;
  llmTokens?: number;
  failureRate?: number;
  forceTier?: 'slm' | 'llm';
}

export function createMockProvider(responses: string[], config: MockConfig = {}) {
  let callIndex = 0;
  const {
    slmLatency = 30,
    llmLatency = 150,
    slmCostPerCall = 0.0001,
    llmCostPerCall = 0.003,
    slmTokens = 150,
    llmTokens = 400,
    failureRate = 0,
    forceTier,
  } = config;

  return {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: async () => true,
    listModels: async () => [
      { id: 'bench-slm', name: 'Benchmark SLM', tier: ModelTier.SLM, provider: 'ollama' },
      { id: 'bench-llm', name: 'Benchmark LLM', tier: ModelTier.LLM, provider: 'ollama' },
    ],
    estimateCost: () => slmCostPerCall,
    chat: async (opts: any) => {
      const idx = callIndex++;
      const content = responses[idx % responses.length] ?? '{}';

      if (failureRate > 0 && Math.random() < failureRate) {
        throw new Error('Simulated provider failure');
      }

      const isLLM = forceTier === 'llm' || (!forceTier && (opts?.model?.includes('llm') || false));
      const latency = isLLM ? llmLatency : slmLatency;
      const cost = isLLM ? llmCostPerCall : slmCostPerCall;
      const tokens = isLLM ? llmTokens : slmTokens;

      await sleep(latency);

      return {
        model: isLLM ? 'bench-llm' : 'bench-slm',
        provider: 'ollama',
        tier: isLLM ? ModelTier.LLM : ModelTier.SLM,
        content,
        tokenUsage: {
          promptTokens: Math.floor(tokens * 0.67),
          completionTokens: Math.floor(tokens * 0.33),
          totalTokens: tokens,
        },
        latencyMs: latency,
        costUsd: cost,
        finishReason: 'stop',
      };
    },
    chatStream: async function* (opts: any) {
      const idx = callIndex++;
      const content = responses[idx % responses.length] ?? '{}';
      const isLLM = forceTier === 'llm' || (!forceTier && (opts?.model?.includes('llm') || false));
      const tokens = isLLM ? llmTokens : slmTokens;

      yield { content, done: false };
      yield {
        content: '',
        done: true,
        tokenUsage: {
          promptTokens: Math.floor(tokens * 0.67),
          completionTokens: Math.floor(tokens * 0.33),
          totalTokens: tokens,
        },
        finishReason: 'stop',
      };
    },
    getCallIndex: () => callIndex,
  };
}

// Standard responses for unified planning (1 LLM call for plan + 1 for synthesis)
export const UNIFIED_RESPONSES = [
  // Response 0: Unified plan
  JSON.stringify({
    spec: { goal: "benchmark task", constraints: [], successCriteria: ["complete"] },
    complexity: 0.3,
    plan: { steps: [{ description: "Execute step", toolName: "bench_tool", toolArgs: { input: "benchmark" } }] },
    planScore: { overall: 0.85, stepConfidences: [0.85], issues: [] },
  }),
  // Response 1: Simulation
  JSON.stringify({ predictedOutcome: "success", confidence: 0.9, risks: [] }),
  // Response 2: Final answer
  'Task completed successfully.',
];

// Complex responses (multi-step)
export const COMPLEX_UNIFIED_RESPONSES = [
  JSON.stringify({
    spec: { goal: "complex benchmark", constraints: ["accuracy"], successCriteria: ["thorough"] },
    complexity: 0.8,
    plan: {
      steps: [
        { description: "Step 1", toolName: "bench_tool", toolArgs: { input: "a" } },
        { description: "Step 2", toolName: "bench_tool", toolArgs: { input: "b" } },
        { description: "Step 3", toolName: "bench_tool", toolArgs: { input: "c" } },
      ]
    },
    planScore: { overall: 0.75, stepConfidences: [0.8, 0.7, 0.75], issues: [] },
  }),
  JSON.stringify({ predictedOutcome: "partial success", confidence: 0.7, risks: ["complexity"] }),
  'Complex task completed with multi-step analysis.',
];

// Verbose responses (for failure case study — uses more tokens)
export const VERBOSE_UNIFIED_RESPONSES = [
  JSON.stringify({
    spec: { goal: "comprehensive analysis", constraints: [], successCriteria: ["thorough"] },
    complexity: 0.9,
    plan: {
      steps: [
        { description: "Search for background info", toolName: "bench_tool", toolArgs: { input: "search1" } },
        { description: "Analyze findings", toolName: "bench_tool", toolArgs: { input: "analyze1" } },
        { description: "Search for more details", toolName: "bench_tool", toolArgs: { input: "search2" } },
        { description: "Deep analysis", toolName: "bench_tool", toolArgs: { input: "analyze2" } },
        { description: "Write comprehensive report", toolName: "bench_tool", toolArgs: { input: "report" } },
        { description: "Search for validation", toolName: "bench_tool", toolArgs: { input: "search3" } },
        { description: "Final analysis", toolName: "bench_tool", toolArgs: { input: "final" } },
      ]
    },
    planScore: { overall: 0.6, stepConfidences: [0.8, 0.7, 0.6, 0.7, 0.8, 0.5, 0.6], issues: [] },
  }),
  JSON.stringify({ predictedOutcome: "success", confidence: 0.6, risks: ["high token usage"] }),
  "Based on my extensive and thorough analysis, " + "I can conclude that the findings are significant. ".repeat(20),
];

// Responses for separate pipeline (no unified planning)
export const SEPARATE_PIPELINE_RESPONSES = [
  '{"goal": "benchmark task", "constraints": [], "successCriteria": []}',
  '{"complexity": 0.3}',
  '{"steps": [{"description": "Execute step", "toolName": "bench_tool", "toolArgs": {"input": "benchmark"}}]}',
  '{"overall": 0.85, "stepConfidences": [0.85], "issues": []}',
  'Task completed successfully.',
];

export const BASE_JOULE_CONFIG = {
  providers: {
    ollama: { enabled: false, baseUrl: 'http://localhost:11434', models: { slm: 'test' } },
  },
  routing: {
    preferLocal: true,
    slmConfidenceThreshold: 0.6,
    complexityThreshold: 0.7,
    providerPriority: { slm: ['ollama'], llm: ['ollama'] },
    maxReplanDepth: 2,
    unifiedPlanning: true,
  },
};

export function makeTask(desc: string, budget: string = 'medium'): Task {
  return {
    id: generateId('task'),
    description: desc,
    budget: budget as any,
    createdAt: new Date().toISOString(),
  };
}
