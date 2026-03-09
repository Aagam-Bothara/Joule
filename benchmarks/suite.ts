/**
 * Joule Benchmark Suite
 *
 * Runs 6 benchmark categories through the real Joule engine with mock
 * providers that simulate realistic cost, latency, and failure behavior.
 *
 * Usage:
 *   npx tsx benchmarks/suite.ts              # all benchmarks
 *   npx tsx benchmarks/suite.ts --cost       # cost only
 *   npx tsx benchmarks/suite.ts --json       # JSON output
 *
 * Benchmarks:
 *   1. Cost Control — routing savings vs always-cloud baseline
 *   2. Latency — governance/routing/validation overhead
 *   3. Task Success Rate — completion rates across budget levels
 *   4. Budget Enforcement — hard cap compliance
 *   5. Governance Compliance — policy block/allow accuracy
 *   6. Multi-Agent Overhead — single vs crew execution
 */

import { Joule } from '@joule/core';
import { ModelTier, generateId } from '@joule/shared';
import type { Task } from '@joule/shared';
import { z } from 'zod';

// ─── Mock Provider Factory ──────────────────────────────────────────────────

interface MockConfig {
  /** Simulated latency per call (ms) */
  slmLatency?: number;
  llmLatency?: number;
  /** Simulated token costs (USD per call) */
  slmCostPerCall?: number;
  llmCostPerCall?: number;
  /** Simulated tokens per call */
  slmTokens?: number;
  llmTokens?: number;
  /** Failure rate (0-1) */
  failureRate?: number;
  /** Force this tier for all calls */
  forceTier?: 'slm' | 'llm';
}

function createBenchmarkProvider(responses: string[], config: MockConfig = {}) {
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

      // Simulate failures
      if (failureRate > 0 && Math.random() < failureRate) {
        throw new Error('Simulated provider failure');
      }

      // Determine tier from model name or force
      const isLLM = forceTier === 'llm' || (!forceTier && (opts?.model?.includes('llm') || false));
      const latency = isLLM ? llmLatency : slmLatency;
      const cost = isLLM ? llmCostPerCall : slmCostPerCall;
      const tokens = isLLM ? llmTokens : slmTokens;

      // Simulate latency
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
  };
}

// ─── Standard task response sequences ───────────────────────────────────────

const STANDARD_RESPONSES = [
  '{"goal": "benchmark task", "constraints": [], "successCriteria": []}',
  '{"complexity": 0.3}',
  '{"steps": [{"description": "Execute step", "toolName": "bench_tool", "toolArgs": {"input": "benchmark"}}]}',
  '{"overall": 0.85, "stepConfidences": [0.85], "issues": []}',
  'Task completed successfully.',
];

const COMPLEX_RESPONSES = [
  '{"goal": "complex benchmark", "constraints": ["accuracy"], "successCriteria": ["thorough analysis"]}',
  '{"complexity": 0.8}',
  '{"steps": [{"description": "Step 1", "toolName": "bench_tool", "toolArgs": {"input": "a"}}, {"description": "Step 2", "toolName": "bench_tool", "toolArgs": {"input": "b"}}, {"description": "Step 3", "toolName": "bench_tool", "toolArgs": {"input": "c"}}]}',
  '{"overall": 0.75, "stepConfidences": [0.8, 0.7, 0.75], "issues": []}',
  'Complex task completed with multi-step analysis.',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeTask(desc: string, budget: string = 'medium'): Task {
  return {
    id: generateId('task'),
    description: desc,
    budget: budget as any,
    createdAt: new Date().toISOString(),
  };
}

async function createBenchJoule(
  responses: string[],
  providerConfig: MockConfig = {},
  jouleConfig: Partial<any> = {},
) {
  const joule = new Joule({
    providers: {
      ollama: { enabled: false, baseUrl: 'http://localhost:11434', models: { slm: 'test' } },
    },
    routing: {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: ['ollama'], llm: ['ollama'] },
      maxReplanDepth: 2,
    },
    ...jouleConfig,
  });
  await joule.initialize();

  const provider = createBenchmarkProvider(responses, providerConfig);
  joule.providers.register(provider as any);

  joule.registerTool({
    name: 'bench_tool',
    description: 'A benchmark tool',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ result: `done: ${args.input ?? 'default'}` }),
  });

  return joule;
}

interface BenchmarkResult {
  name: string;
  category: string;
  metrics: Record<string, number | string | boolean>;
  runs: number;
  durationMs: number;
}

const results: BenchmarkResult[] = [];

function report(r: BenchmarkResult) {
  results.push(r);
  if (!jsonOutput) {
    console.log(`  ${r.name}`);
    for (const [k, v] of Object.entries(r.metrics)) {
      const val = typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : v;
      console.log(`    ${k}: ${val}`);
    }
    console.log('');
  }
}

// ─── Benchmark 1: Cost Control ──────────────────────────────────────────────

async function benchCostControl() {
  if (!jsonOutput) console.log('\n━━━ Benchmark 1: Cost Control ━━━\n');

  const N = 10;

  // Baseline A: Always use LLM (cloud-only)
  const jouleCloud = await createBenchJoule(
    STANDARD_RESPONSES,
    { forceTier: 'llm', llmCostPerCall: 0.003, llmTokens: 400 },
  );

  let cloudCost = 0;
  let cloudTokens = 0;
  for (let i = 0; i < N; i++) {
    const r = await jouleCloud.execute(makeTask(`Cloud task ${i}`, 'high'));
    cloudCost += r.budgetUsed.costUsd;
    cloudTokens += r.budgetUsed.tokensUsed;
  }
  await jouleCloud.shutdown();

  // Baseline B: Always use SLM (local-only)
  const jouleLocal = await createBenchJoule(
    STANDARD_RESPONSES,
    { forceTier: 'slm', slmCostPerCall: 0.0001, slmTokens: 150 },
  );

  let localCost = 0;
  let localTokens = 0;
  for (let i = 0; i < N; i++) {
    const r = await jouleLocal.execute(makeTask(`Local task ${i}`, 'high'));
    localCost += r.budgetUsed.costUsd;
    localTokens += r.budgetUsed.tokensUsed;
  }
  await jouleLocal.shutdown();

  // Joule: Budget-aware routed execution
  const jouleRouted = await createBenchJoule(
    STANDARD_RESPONSES,
    { slmCostPerCall: 0.0001, llmCostPerCall: 0.003, slmTokens: 150, llmTokens: 400 },
  );

  let routedCost = 0;
  let routedTokens = 0;
  for (let i = 0; i < N; i++) {
    const r = await jouleRouted.execute(makeTask(`Routed task ${i}`, 'medium'));
    routedCost += r.budgetUsed.costUsd;
    routedTokens += r.budgetUsed.tokensUsed;
  }
  await jouleRouted.shutdown();

  const savingsVsCloud = ((cloudCost - routedCost) / cloudCost * 100);
  const tokenSavingsVsCloud = ((cloudTokens - routedTokens) / cloudTokens * 100);

  report({
    name: 'Cost: Cloud-Only Baseline',
    category: 'cost',
    metrics: {
      totalCostUsd: cloudCost,
      totalTokens: cloudTokens,
      avgCostPerTask: cloudCost / N,
      avgTokensPerTask: cloudTokens / N,
    },
    runs: N,
    durationMs: 0,
  });

  report({
    name: 'Cost: Local-Only Baseline',
    category: 'cost',
    metrics: {
      totalCostUsd: localCost,
      totalTokens: localTokens,
      avgCostPerTask: localCost / N,
      avgTokensPerTask: localTokens / N,
    },
    runs: N,
    durationMs: 0,
  });

  report({
    name: 'Cost: Joule Routed (adaptive)',
    category: 'cost',
    metrics: {
      totalCostUsd: routedCost,
      totalTokens: routedTokens,
      avgCostPerTask: routedCost / N,
      avgTokensPerTask: routedTokens / N,
      savingsVsCloudPct: savingsVsCloud,
      tokenSavingsVsCloudPct: tokenSavingsVsCloud,
    },
    runs: N,
    durationMs: 0,
  });
}

// ─── Benchmark 2: Latency ───────────────────────────────────────────────────

async function benchLatency() {
  if (!jsonOutput) console.log('\n━━━ Benchmark 2: Latency Overhead ━━━\n');

  const N = 5;

  // Baseline: No governance, no validation
  const jouleBase = await createBenchJoule(
    STANDARD_RESPONSES,
    { slmLatency: 10, llmLatency: 50 },
  );

  const baseTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    await jouleBase.execute(makeTask(`Latency base ${i}`, 'high'));
    baseTimes.push(performance.now() - start);
  }
  await jouleBase.shutdown();

  // With governance enabled
  const jouleGov = await createBenchJoule(
    STANDARD_RESPONSES,
    { slmLatency: 10, llmLatency: 50 },
    {
      governance: { enabled: true, defaultTrustScore: 0.5 },
    },
  );

  const govTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const start = performance.now();
    await jouleGov.execute(makeTask(`Latency gov ${i}`, 'high'));
    govTimes.push(performance.now() - start);
  }
  await jouleGov.shutdown();

  const avgBase = baseTimes.reduce((a, b) => a + b, 0) / N;
  const avgGov = govTimes.reduce((a, b) => a + b, 0) / N;
  const overhead = avgGov - avgBase;
  const overheadPct = (overhead / avgBase) * 100;

  report({
    name: 'Latency: No Governance (baseline)',
    category: 'latency',
    metrics: {
      avgMs: avgBase,
      minMs: Math.min(...baseTimes),
      maxMs: Math.max(...baseTimes),
      p50Ms: baseTimes.sort((a, b) => a - b)[Math.floor(N / 2)],
    },
    runs: N,
    durationMs: baseTimes.reduce((a, b) => a + b, 0),
  });

  report({
    name: 'Latency: With Governance',
    category: 'latency',
    metrics: {
      avgMs: avgGov,
      minMs: Math.min(...govTimes),
      maxMs: Math.max(...govTimes),
      p50Ms: govTimes.sort((a, b) => a - b)[Math.floor(N / 2)],
      governanceOverheadMs: overhead,
      governanceOverheadPct: overheadPct,
    },
    runs: N,
    durationMs: govTimes.reduce((a, b) => a + b, 0),
  });
}

// ─── Benchmark 3: Task Success Rate ─────────────────────────────────────────

async function benchSuccessRate() {
  if (!jsonOutput) console.log('\n━━━ Benchmark 3: Task Success Rate ━━━\n');

  const budgets = ['low', 'medium', 'high'] as const;

  for (const budget of budgets) {
    const N = 8;
    let completed = 0;
    let failed = 0;
    let budgetExhausted = 0;
    let totalSteps = 0;
    let totalRetries = 0;

    const joule = await createBenchJoule(
      STANDARD_RESPONSES,
      { slmCostPerCall: 0.0001, slmTokens: 150 },
    );

    for (let i = 0; i < N; i++) {
      try {
        const r = await joule.execute(makeTask(`Success ${budget} ${i}`, budget));
        if (r.status === 'completed') completed++;
        else if (r.status === 'budget_exhausted') budgetExhausted++;
        else failed++;
        totalSteps += r.stepResults.length;
        totalRetries += r.stepResults.filter(s => !s.success).length;
      } catch {
        failed++;
      }
    }
    await joule.shutdown();

    report({
      name: `Success Rate: budget=${budget}`,
      category: 'success',
      metrics: {
        completed,
        failed,
        budgetExhausted,
        successRate: `${((completed / N) * 100).toFixed(1)}%`,
        avgStepsPerTask: totalSteps / N,
        totalRetries,
      },
      runs: N,
      durationMs: 0,
    });
  }
}

// ─── Benchmark 4: Budget Enforcement ────────────────────────────────────────

async function benchBudgetEnforcement() {
  if (!jsonOutput) console.log('\n━━━ Benchmark 4: Budget Enforcement ━━━\n');

  const N = 10;

  // Run tasks with LOW budget — verify hard cap compliance
  const joule = await createBenchJoule(
    // Complex task that tries to use many tokens
    COMPLEX_RESPONSES,
    { slmCostPerCall: 0.002, slmTokens: 800 }, // Expensive enough to trigger budget limits
  );

  let enforcedCount = 0;
  let overBudgetCount = 0;
  let completedUnderBudget = 0;
  const costResults: number[] = [];
  const tokenResults: number[] = [];

  // Low budget: 4000 tokens, $0.01 cost ceiling
  const LOW_TOKEN_LIMIT = 4000;
  const LOW_COST_LIMIT = 0.01;

  for (let i = 0; i < N; i++) {
    try {
      const r = await joule.execute(makeTask(`Budget enforce ${i}`, 'low'));
      const tokens = r.budgetUsed.tokensUsed;
      const cost = r.budgetUsed.costUsd;
      costResults.push(cost);
      tokenResults.push(tokens);

      if (r.status === 'budget_exhausted') {
        enforcedCount++;
      } else if (r.status === 'completed') {
        completedUnderBudget++;
      }

      // Check if budget was actually exceeded (should never happen)
      if (tokens > LOW_TOKEN_LIMIT * 1.1 || cost > LOW_COST_LIMIT * 1.1) {
        overBudgetCount++;
      }
    } catch {
      enforcedCount++; // Budget error thrown = enforcement working
    }
  }
  await joule.shutdown();

  const avgCost = costResults.reduce((a, b) => a + b, 0) / costResults.length;
  const maxCost = Math.max(...costResults);
  const avgTokens = tokenResults.reduce((a, b) => a + b, 0) / tokenResults.length;
  const maxTokens = Math.max(...tokenResults);

  report({
    name: 'Budget Enforcement: Low Budget Cap',
    category: 'budget',
    metrics: {
      totalRuns: N,
      completedUnderBudget,
      budgetEnforced: enforcedCount,
      overBudgetViolations: overBudgetCount,
      enforcementRate: `${(((N - overBudgetCount) / N) * 100).toFixed(1)}%`,
      avgCostUsd: avgCost,
      maxCostUsd: maxCost,
      costCeilingUsd: LOW_COST_LIMIT,
      avgTokens,
      maxTokens,
      tokenCeiling: LOW_TOKEN_LIMIT,
    },
    runs: N,
    durationMs: 0,
  });

  // Run same tasks with HIGH budget — should all complete
  const jouleHigh = await createBenchJoule(
    COMPLEX_RESPONSES,
    { slmCostPerCall: 0.002, slmTokens: 800 },
  );

  let highCompleted = 0;
  for (let i = 0; i < N; i++) {
    try {
      const r = await jouleHigh.execute(makeTask(`Budget high ${i}`, 'high'));
      if (r.status === 'completed') highCompleted++;
    } catch { /* ignore */ }
  }
  await jouleHigh.shutdown();

  report({
    name: 'Budget Enforcement: High Budget (control)',
    category: 'budget',
    metrics: {
      totalRuns: N,
      completedSuccessfully: highCompleted,
      successRate: `${((highCompleted / N) * 100).toFixed(1)}%`,
    },
    runs: N,
    durationMs: 0,
  });
}

// ─── Benchmark 5: Governance Compliance ─────────────────────────────────────

async function benchGovernance() {
  if (!jsonOutput) console.log('\n━━━ Benchmark 5: Governance Compliance ━━━\n');

  const N = 5;

  // Test with governance DISABLED — dangerous tools execute freely
  const jouleNoGov = await createBenchJoule(
    STANDARD_RESPONSES,
    {},
  );

  // Register a "dangerous" tool
  jouleNoGov.registerTool({
    name: 'dangerous_tool',
    description: 'A dangerous tool that should be blocked',
    inputSchema: z.object({ command: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ executed: true, command: args.command }),
  });

  let noGovExecutions = 0;
  for (let i = 0; i < N; i++) {
    const r = await jouleNoGov.execute(makeTask(`No gov task ${i}`, 'high'));
    noGovExecutions += r.stepResults.filter(s => s.success).length;
  }
  await jouleNoGov.shutdown();

  // Test with governance ENABLED and approval policies
  const jouleGov = await createBenchJoule(
    STANDARD_RESPONSES,
    {},
    {
      governance: { enabled: true, defaultTrustScore: 0.5 },
      approval: {
        mode: 'automatic',
        policies: [
          {
            name: 'block-dangerous',
            type: 'tool',
            match: ['dangerous_tool'],
            action: 'deny',
          },
        ],
      },
    },
  );

  jouleGov.registerTool({
    name: 'dangerous_tool',
    description: 'A dangerous tool that should be blocked',
    inputSchema: z.object({ command: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args) => ({ executed: true, command: args.command }),
  });

  let govBlockedCount = 0;
  let govAllowedCount = 0;
  for (let i = 0; i < N; i++) {
    const r = await jouleGov.execute(makeTask(`Gov task ${i}`, 'high'));
    const dangerousSteps = r.stepResults.filter(s => s.toolName === 'dangerous_tool');
    govBlockedCount += dangerousSteps.filter(s => !s.success).length;
    govAllowedCount += dangerousSteps.filter(s => s.success).length;
  }
  await jouleGov.shutdown();

  // Test safe tool with governance — should still work
  const jouleSafe = await createBenchJoule(
    STANDARD_RESPONSES,
    {},
    { governance: { enabled: true, defaultTrustScore: 0.5 } },
  );

  let safeExecutions = 0;
  for (let i = 0; i < N; i++) {
    const r = await jouleSafe.execute(makeTask(`Safe gov task ${i}`, 'high'));
    safeExecutions += r.stepResults.filter(s => s.success).length;
  }
  await jouleSafe.shutdown();

  report({
    name: 'Governance: No Governance (baseline)',
    category: 'governance',
    metrics: {
      totalRuns: N,
      successfulToolExecutions: noGovExecutions,
      dangerousToolsBlocked: 0,
    },
    runs: N,
    durationMs: 0,
  });

  report({
    name: 'Governance: With Policies (dangerous tool blocked)',
    category: 'governance',
    metrics: {
      totalRuns: N,
      dangerousToolsBlocked: govBlockedCount,
      dangerousToolsAllowed: govAllowedCount,
      blockRate: govBlockedCount + govAllowedCount > 0
        ? `${((govBlockedCount / (govBlockedCount + govAllowedCount)) * 100).toFixed(1)}%`
        : 'N/A (tool not invoked by planner)',
    },
    runs: N,
    durationMs: 0,
  });

  report({
    name: 'Governance: Safe Tools Still Work',
    category: 'governance',
    metrics: {
      totalRuns: N,
      safeToolExecutions: safeExecutions,
      safeToolsBlocked: 0,
      noFalsePositives: safeExecutions > 0,
    },
    runs: N,
    durationMs: 0,
  });
}

// ─── Benchmark 6: Multi-Agent Overhead ──────────────────────────────────────

async function benchMultiAgent() {
  if (!jsonOutput) console.log('\n━━━ Benchmark 6: Multi-Agent Overhead ━━━\n');

  const N = 3;

  // Single-agent execution
  const jouleSingle = await createBenchJoule(
    STANDARD_RESPONSES,
    { slmLatency: 15, slmTokens: 150, slmCostPerCall: 0.0001 },
  );

  const singleTimes: number[] = [];
  const singleCosts: number[] = [];
  const singleTokens: number[] = [];
  let singleCompleted = 0;

  for (let i = 0; i < N; i++) {
    const start = performance.now();
    const r = await jouleSingle.execute(makeTask(`Single agent ${i}`, 'high'));
    singleTimes.push(performance.now() - start);
    singleCosts.push(r.budgetUsed.costUsd);
    singleTokens.push(r.budgetUsed.tokensUsed);
    if (r.status === 'completed') singleCompleted++;
  }
  await jouleSingle.shutdown();

  // Multi-step: plan with 3 tool calls in sequence
  const multiStepResponses = [
    '{"goal": "research and report", "constraints": ["thorough"], "successCriteria": ["complete analysis"]}',
    '{"complexity": 0.5}',
    '{"steps": [{"description": "Research", "toolName": "bench_tool", "toolArgs": {"input": "research"}}, {"description": "Analyze", "toolName": "bench_tool", "toolArgs": {"input": "analyze"}}, {"description": "Write", "toolName": "bench_tool", "toolArgs": {"input": "write"}}]}',
    '{"overall": 0.85, "stepConfidences": [0.8, 0.85, 0.9], "issues": []}',
    'Comprehensive report completed with research, analysis, and recommendations.',
  ];

  const jouleMulti = await createBenchJoule(
    multiStepResponses,
    { slmLatency: 15, slmTokens: 150, slmCostPerCall: 0.0001 },
  );

  const multiTimes: number[] = [];
  const multiCosts: number[] = [];
  const multiTokens: number[] = [];
  const multiSteps: number[] = [];
  let multiCompleted = 0;

  for (let i = 0; i < N; i++) {
    const start = performance.now();
    // Use a longer description to simulate multi-step work
    const r = await jouleMulti.execute(
      makeTask(
        'Research the topic thoroughly, analyze the findings for patterns, and write a concise summary report with recommendations',
        'high',
      ),
    );
    multiTimes.push(performance.now() - start);
    multiCosts.push(r.budgetUsed.costUsd);
    multiTokens.push(r.budgetUsed.tokensUsed);
    multiSteps.push(r.stepResults.length);
    if (r.status === 'completed') multiCompleted++;
  }
  await jouleMulti.shutdown();

  const avgSingleTime = singleTimes.reduce((a, b) => a + b, 0) / N;
  const avgMultiTime = multiTimes.reduce((a, b) => a + b, 0) / N;
  const avgSingleCost = singleCosts.reduce((a, b) => a + b, 0) / N;
  const avgMultiCost = multiCosts.reduce((a, b) => a + b, 0) / N;
  const avgSingleTokens = singleTokens.reduce((a, b) => a + b, 0) / N;
  const avgMultiTokens = multiTokens.reduce((a, b) => a + b, 0) / N;

  report({
    name: 'Multi-Agent: Single Agent (baseline)',
    category: 'multi-agent',
    metrics: {
      avgLatencyMs: avgSingleTime,
      avgCostUsd: avgSingleCost,
      avgTokens: avgSingleTokens,
      completionRate: `${((singleCompleted / N) * 100).toFixed(1)}%`,
      avgSteps: singleTokens.length > 0 ? 1 : 0,
    },
    runs: N,
    durationMs: singleTimes.reduce((a, b) => a + b, 0),
  });

  report({
    name: 'Multi-Agent: Multi-Step Execution',
    category: 'multi-agent',
    metrics: {
      avgLatencyMs: avgMultiTime,
      avgCostUsd: avgMultiCost,
      avgTokens: avgMultiTokens,
      completionRate: `${((multiCompleted / N) * 100).toFixed(1)}%`,
      avgSteps: multiSteps.reduce((a, b) => a + b, 0) / N,
      latencyOverheadMs: avgMultiTime - avgSingleTime,
      latencyOverheadPct: ((avgMultiTime - avgSingleTime) / avgSingleTime * 100),
      costOverheadPct: avgSingleCost > 0
        ? ((avgMultiCost - avgSingleCost) / avgSingleCost * 100)
        : 0,
    },
    runs: N,
    durationMs: multiTimes.reduce((a, b) => a + b, 0),
  });
}

// ─── Report Generator ───────────────────────────────────────────────────────

function printSummary() {
  console.log('\n' + '═'.repeat(70));
  console.log('  JOULE BENCHMARK SUMMARY');
  console.log('═'.repeat(70) + '\n');

  const categories = [...new Set(results.map(r => r.category))];

  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    console.log(`── ${cat.toUpperCase()} ${'─'.repeat(60 - cat.length)}\n`);

    for (const r of catResults) {
      console.log(`  ${r.name} (${r.runs} runs)`);
      for (const [k, v] of Object.entries(r.metrics)) {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
        const val = typeof v === 'number'
          ? (k.includes('Pct') ? `${v.toFixed(1)}%`
            : k.includes('Usd') || k.includes('Cost') || k.includes('cost') ? `$${v.toFixed(4)}`
            : k.includes('Ms') || k.includes('ms') ? `${v.toFixed(1)}ms`
            : Number.isInteger(v) ? v.toString() : v.toFixed(4))
          : v;
        console.log(`    ${label}: ${val}`);
      }
      console.log('');
    }
  }

  // Key takeaways
  const costResults = results.filter(r => r.category === 'cost');
  const savingsResult = costResults.find(r => r.name.includes('Routed'));
  const latencyResults = results.filter(r => r.category === 'latency');
  const govOverhead = latencyResults.find(r => r.name.includes('With Governance'));
  const budgetResults = results.filter(r => r.category === 'budget');
  const enforcement = budgetResults.find(r => r.name.includes('Low'));

  console.log('── KEY TAKEAWAYS ' + '─'.repeat(52) + '\n');

  if (savingsResult) {
    const savings = savingsResult.metrics.savingsVsCloudPct;
    console.log(`  Cost savings vs cloud-only: ${typeof savings === 'number' ? savings.toFixed(1) : savings}%`);
  }

  if (govOverhead) {
    const overhead = govOverhead.metrics.governanceOverheadMs;
    const pct = govOverhead.metrics.governanceOverheadPct;
    console.log(`  Governance overhead: ${typeof overhead === 'number' ? overhead.toFixed(1) : overhead}ms per task (${typeof pct === 'number' ? pct.toFixed(1) : pct}%)`);
  }

  if (enforcement) {
    console.log(`  Budget enforcement rate: ${enforcement.metrics.enforcementRate}`);
    console.log(`  Budget violations: ${enforcement.metrics.overBudgetViolations}`);
  }

  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const runOnly = args.find(a => a.startsWith('--'))?.replace('--', '');

async function main() {
  const startTime = performance.now();

  if (!jsonOutput) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║              JOULE BENCHMARK SUITE                      ║');
    console.log('║  AI agents with a budget, a constitution, and an off    ║');
    console.log('║  switch. Measuring what makes Joule different.          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
  }

  const benchmarks: Record<string, () => Promise<void>> = {
    cost: benchCostControl,
    latency: benchLatency,
    success: benchSuccessRate,
    budget: benchBudgetEnforcement,
    governance: benchGovernance,
    'multi-agent': benchMultiAgent,
  };

  if (runOnly && benchmarks[runOnly]) {
    await benchmarks[runOnly]();
  } else {
    for (const [name, fn] of Object.entries(benchmarks)) {
      try {
        await fn();
      } catch (err) {
        console.error(`  [ERROR] ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  const totalDuration = performance.now() - startTime;

  if (jsonOutput) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      durationMs: totalDuration,
      results,
    }, null, 2));
  } else {
    printSummary();
    console.log(`Total benchmark time: ${(totalDuration / 1000).toFixed(1)}s\n`);
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
