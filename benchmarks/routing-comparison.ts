/**
 * Routing Comparison Benchmark
 *
 * Compares SLM-only vs LLM-only vs Joule's adaptive routing
 * across different task complexities.
 *
 * Usage: npx tsx benchmarks/routing-comparison.ts
 */

import { ModelTier, BUDGET_PRESETS, MODEL_PRICING, estimateEnergy } from '@joule/shared';

interface SimulatedTask {
  description: string;
  complexity: number;
  requiredTokens: { slm: number; llm: number };
  successRate: { slm: number; llm: number };
}

const TASKS: SimulatedTask[] = [
  {
    description: 'Simple lookup: What is 2+2?',
    complexity: 0.1,
    requiredTokens: { slm: 500, llm: 300 },
    successRate: { slm: 0.99, llm: 0.99 },
  },
  {
    description: 'File listing: Show files in /tmp',
    complexity: 0.2,
    requiredTokens: { slm: 800, llm: 600 },
    successRate: { slm: 0.95, llm: 0.99 },
  },
  {
    description: 'Multi-step: Read config and modify value',
    complexity: 0.5,
    requiredTokens: { slm: 2000, llm: 1500 },
    successRate: { slm: 0.70, llm: 0.95 },
  },
  {
    description: 'Analysis: Analyze log patterns',
    complexity: 0.7,
    requiredTokens: { slm: 5000, llm: 3000 },
    successRate: { slm: 0.40, llm: 0.90 },
  },
  {
    description: 'Creative: Write a deployment plan',
    complexity: 0.9,
    requiredTokens: { slm: 8000, llm: 4000 },
    successRate: { slm: 0.15, llm: 0.85 },
  },
];

interface StrategyResult {
  name: string;
  totalTokens: number;
  totalCostUsd: number;
  totalEnergyWh: number;
  successCount: number;
  totalTasks: number;
}

function simulateStrategy(
  name: string,
  tasks: SimulatedTask[],
  routeFn: (task: SimulatedTask) => 'slm' | 'llm',
): StrategyResult {
  let totalTokens = 0;
  let totalCost = 0;
  let totalEnergy = 0;
  let successCount = 0;

  const slmModel = 'llama3.2:3b';
  const llmModel = 'claude-3-5-sonnet-20241022';

  for (const task of tasks) {
    const tier = routeFn(task);
    const tokens = task.requiredTokens[tier];
    const success = Math.random() < task.successRate[tier];

    totalTokens += tokens;

    const model = tier === 'slm' ? slmModel : llmModel;
    const pricing = MODEL_PRICING[model];
    if (pricing) {
      totalCost += (tokens * (pricing.inputPerMillion + pricing.outputPerMillion) / 2) / 1_000_000;
    }

    totalEnergy += estimateEnergy(model, Math.floor(tokens / 2), Math.floor(tokens / 2));
    if (success) successCount++;
  }

  return { name, totalTokens, totalCostUsd: totalCost, totalEnergyWh: totalEnergy, successCount, totalTasks: tasks.length };
}

// Run comparison
console.log('=== Joule Routing Comparison Benchmark ===\n');

const strategies: StrategyResult[] = [
  simulateStrategy('SLM Only', TASKS, () => 'slm'),
  simulateStrategy('LLM Only', TASKS, () => 'llm'),
  simulateStrategy('Joule Adaptive', TASKS, (task) => task.complexity > 0.7 ? 'llm' : 'slm'),
];

// Print results table
const header = `${'Strategy'.padEnd(20)} ${'Tokens'.padStart(10)} ${'Cost'.padStart(10)} ${'Energy'.padStart(12)} ${'Success'.padStart(10)}`;
console.log(header);
console.log('-'.repeat(header.length));

for (const s of strategies) {
  console.log(
    `${s.name.padEnd(20)} ${s.totalTokens.toLocaleString().padStart(10)} ${'$' + s.totalCostUsd.toFixed(4).padStart(9)} ${(s.totalEnergyWh.toFixed(6) + ' Wh').padStart(12)} ${`${s.successCount}/${s.totalTasks}`.padStart(10)}`,
  );
}

// Calculate savings
const llmOnly = strategies[1];
const joule = strategies[2];
const costSavings = ((llmOnly.totalCostUsd - joule.totalCostUsd) / llmOnly.totalCostUsd * 100).toFixed(1);
const energySavings = ((llmOnly.totalEnergyWh - joule.totalEnergyWh) / llmOnly.totalEnergyWh * 100).toFixed(1);

console.log(`\n--- Joule vs LLM-Only ---`);
console.log(`Cost savings:   ${costSavings}%`);
console.log(`Energy savings: ${energySavings}%`);
console.log(`Token savings:  ${((llmOnly.totalTokens - joule.totalTokens) / llmOnly.totalTokens * 100).toFixed(1)}%`);
