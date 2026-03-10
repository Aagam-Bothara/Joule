/**
 * Scale Experiment: 100+ Task Budget Enforcement
 * ================================================
 * Runs N tasks through Joule with varying budgets and complexities,
 * proving budget enforcement holds at scale.
 *
 * Usage:
 *   npx tsx paper/scale-experiment.ts                  # 100 tasks (mock)
 *   npx tsx paper/scale-experiment.ts --tasks=200      # 200 tasks
 *   npx tsx paper/scale-experiment.ts --json            # JSON output
 */

import { Joule } from '@joule/core';
import { BUDGET_PRESETS } from '@joule/shared';
import type { Task, BudgetPreset } from '@joule/shared';
import { z } from 'zod';
import * as fs from 'fs';
import {
  createMockProvider,
  UNIFIED_RESPONSES,
  COMPLEX_UNIFIED_RESPONSES,
  BASE_JOULE_CONFIG,
  generateId,
} from './shared-mock.js';

// ── Task Pool ───────────────────────────────────────────────────────────────

const BASE_TASKS = [
  { description: "What is the capital of France?", complexity: "low" },
  { description: "Convert 72°F to Celsius.", complexity: "low" },
  { description: "List the 3 primary colors.", complexity: "low" },
  { description: "What is 17 * 23?", complexity: "low" },
  { description: "Name the 4 seasons.", complexity: "low" },
  { description: "Define 'recursion' in one sentence.", complexity: "low" },
  { description: "What year was the moon landing?", complexity: "low" },
  { description: "Explain TCP vs UDP with use cases.", complexity: "medium" },
  { description: "Analyze sales data: Q1 120K, Q2 145K, Q3 98K, Q4 167K.", complexity: "medium" },
  { description: "Write a Python function for longest common subsequence.", complexity: "medium" },
  { description: "Explain CAP theorem with examples.", complexity: "medium" },
  { description: "Compare REST vs GraphQL across 5 dimensions.", complexity: "medium" },
  { description: "Explain how B-tree indexes work.", complexity: "medium" },
  { description: "Compare microservices vs monolithic across 8 dimensions.", complexity: "high" },
  { description: "Report on quantum computing impact on cryptography.", complexity: "high" },
  { description: "Design a distributed rate limiter.", complexity: "high" },
];

interface ScaleMeasurement {
  taskIndex: number;
  description: string;
  complexity: string;
  budget: string;
  status: string;
  durationMs: number;
  tokensUsed: number;
  costUsd: number;
  toolCalls: number;
  escalations: number;
  steps: number;
  budgetExhausted: boolean;
  budgetUtilization: number;
}

// ── Distribution Bucketing ──────────────────────────────────────────────────

function bucketize(values: number[], buckets: number[]): { bucket: string; count: number }[] {
  const result: { bucket: string; count: number }[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const low = i === 0 ? 0 : buckets[i - 1];
    const high = buckets[i];
    const label = i === 0 ? `<${high}` : `${low}-${high}`;
    result.push({ bucket: label, count: values.filter(v => v >= low && v < high).length });
  }
  result.push({
    bucket: `>${buckets[buckets.length - 1]}`,
    count: values.filter(v => v >= buckets[buckets.length - 1]).length,
  });
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const numTasks = parseInt(args.find(a => a.startsWith('--tasks='))?.split('=')[1] || '100');
  const jsonOutput = args.includes('--json');

  console.log('\n' + '═'.repeat(70));
  console.log('  JOULE SCALE EXPERIMENT');
  console.log(`  Tasks: ${numTasks} | Mode: MOCK`);
  console.log('═'.repeat(70) + '\n');

  // Generate task list with varying budgets
  const budgetLevels: BudgetPreset[] = ['low', 'medium', 'high'];
  const taskList: { task: typeof BASE_TASKS[0]; budget: BudgetPreset }[] = [];
  for (let i = 0; i < numTasks; i++) {
    const taskDef = BASE_TASKS[i % BASE_TASKS.length];
    let budget: BudgetPreset;
    if (taskDef.complexity === 'low') budget = Math.random() < 0.5 ? 'low' : 'medium';
    else if (taskDef.complexity === 'medium') budget = Math.random() < 0.5 ? 'medium' : 'high';
    else budget = 'high';
    taskList.push({ task: taskDef, budget });
  }

  const measurements: ScaleMeasurement[] = [];
  const batchSize = 5;
  const startTime = performance.now();

  for (let batch = 0; batch < Math.ceil(numTasks / batchSize); batch++) {
    const batchStart = batch * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, numTasks);
    const batchTasks = taskList.slice(batchStart, batchEnd);

    // Each task gets its own Joule instance (like suite.ts does)
    const batchPromises = batchTasks.map(async ({ task, budget }, idx) => {
      const taskIndex = batchStart + idx;
      const isComplex = task.complexity === 'high';
      const responses = isComplex ? COMPLEX_UNIFIED_RESPONSES : UNIFIED_RESPONSES;

      const joule = new Joule({
        ...BASE_JOULE_CONFIG,
        budgetPreset: budget,
      });
      await joule.initialize();

      const provider = createMockProvider(responses, {
        slmLatency: 5,
        llmLatency: 15,
        slmTokens: isComplex ? 300 : 150,
        llmTokens: isComplex ? 600 : 400,
      });
      joule.providers.register(provider as any);

      joule.registerTool({
        name: 'bench_tool',
        description: 'A benchmark tool',
        inputSchema: z.object({ input: z.string().optional() }).passthrough(),
        outputSchema: z.any(),
        execute: async (args: any) => ({ result: `done: ${args.input ?? 'default'}` }),
      });

      const taskObj: Task = {
        id: generateId('scale'),
        description: task.description,
        budget,
        createdAt: new Date().toISOString(),
      };

      const taskStart = performance.now();
      try {
        const result = await joule.execute(taskObj);
        const durationMs = performance.now() - taskStart;
        const bu = result.budgetUsed;
        const preset = BUDGET_PRESETS[budget];

        await joule.shutdown();
        return {
          taskIndex,
          description: task.description.slice(0, 60),
          complexity: task.complexity,
          budget,
          status: result.status,
          durationMs: Math.round(durationMs),
          tokensUsed: bu?.tokensUsed ?? 0,
          costUsd: bu?.costUsd ?? 0,
          toolCalls: bu?.toolCallsUsed ?? 0,
          escalations: bu?.escalationsUsed ?? 0,
          steps: result.stepResults?.length ?? 0,
          budgetExhausted: result.status === 'budget_exhausted',
          budgetUtilization: preset ? (bu?.tokensUsed ?? 0) / preset.maxTokens : 0,
        } as ScaleMeasurement;
      } catch (err: any) {
        await joule.shutdown();
        return {
          taskIndex,
          description: task.description.slice(0, 60),
          complexity: task.complexity,
          budget,
          status: 'error',
          durationMs: Math.round(performance.now() - taskStart),
          tokensUsed: 0,
          costUsd: 0,
          toolCalls: 0,
          escalations: 0,
          steps: 0,
          budgetExhausted: false,
          budgetUtilization: 0,
        } as ScaleMeasurement;
      }
    });

    const batchResults = await Promise.all(batchPromises);
    measurements.push(...batchResults);

    const pct = Math.round(batchEnd / numTasks * 100);
    const completed = batchResults.filter(m => m.status === 'completed').length;
    const exhausted = batchResults.filter(m => m.budgetExhausted).length;
    process.stdout.write(`\r  Progress: ${batchEnd}/${numTasks} (${pct}%) | Batch: ${completed}✓ ${exhausted}⚠`);
  }

  const totalDuration = performance.now() - startTime;
  console.log(`\n  Total time: ${(totalDuration / 1000).toFixed(1)}s\n`);

  // ── Compute Results ──────────────────────────────────────────────────────

  const completed = measurements.filter(m => m.status === 'completed');
  const exhausted = measurements.filter(m => m.budgetExhausted);
  const failed = measurements.filter(m => m.status === 'error' || m.status === 'failed');

  const violations = measurements.filter(m => {
    const preset = BUDGET_PRESETS[m.budget as keyof typeof BUDGET_PRESETS];
    if (!preset) return false;
    return m.tokensUsed > preset.maxTokens * 1.15 || m.costUsd > (preset.costCeiling ?? Infinity) * 1.15;
  });

  const costs = completed.map(m => m.costUsd);
  const tokens = completed.map(m => m.tokensUsed);

  const byComplexity: Record<string, any> = {};
  for (const c of ['low', 'medium', 'high']) {
    const subset = measurements.filter(m => m.complexity === c);
    const sub = subset.filter(m => m.status === 'completed');
    byComplexity[c] = {
      count: subset.length,
      completed: sub.length,
      avgCost: sub.length > 0 ? sub.reduce((s, m) => s + m.costUsd, 0) / sub.length : 0,
      avgTokens: sub.length > 0 ? sub.reduce((s, m) => s + m.tokensUsed, 0) / sub.length : 0,
      avgDuration: sub.length > 0 ? sub.reduce((s, m) => s + m.durationMs, 0) / sub.length : 0,
      budgetExhausted: subset.filter(m => m.budgetExhausted).length,
    };
  }

  const byBudget: Record<string, any> = {};
  for (const b of budgetLevels) {
    const subset = measurements.filter(m => m.budget === b);
    const sub = subset.filter(m => m.status === 'completed');
    const subV = subset.filter(m => {
      const preset = BUDGET_PRESETS[b];
      return m.tokensUsed > preset.maxTokens * 1.15;
    });
    byBudget[b] = {
      count: subset.length,
      completed: sub.length,
      avgCost: sub.length > 0 ? sub.reduce((s, m) => s + m.costUsd, 0) / sub.length : 0,
      avgTokens: sub.length > 0 ? sub.reduce((s, m) => s + m.tokensUsed, 0) / sub.length : 0,
      budgetExhausted: subset.filter(m => m.budgetExhausted).length,
      enforcementRate: subset.length > 0 ? ((subset.length - subV.length) / subset.length * 100) : 100,
    };
  }

  const results = {
    totalTasks: numTasks,
    completedTasks: completed.length,
    successRate: completed.length / numTasks * 100,
    budgetExhaustedCount: exhausted.length,
    budgetEnforcementRate: numTasks > 0 ? ((numTasks - violations.length) / numTasks * 100) : 100,
    failedCount: failed.length,
    totalCost: costs.reduce((s, c) => s + c, 0),
    avgCostPerTask: costs.length > 0 ? costs.reduce((s, c) => s + c, 0) / costs.length : 0,
    totalTokens: tokens.reduce((s, t) => s + t, 0),
    avgTokensPerTask: tokens.length > 0 ? tokens.reduce((s, t) => s + t, 0) / tokens.length : 0,
    avgDurationMs: completed.length > 0 ? completed.reduce((s, m) => s + m.durationMs, 0) / completed.length : 0,
    costDistribution: bucketize(costs, [0.001, 0.005, 0.01, 0.05, 0.1, 0.5]),
    tokenDistribution: bucketize(tokens, [100, 500, 1000, 2000, 5000, 10000]),
    byComplexity,
    byBudget,
    measurements,
  };

  // ── Output ────────────────────────────────────────────────────────────────

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('═'.repeat(70));
    console.log('  SCALE EXPERIMENT RESULTS');
    console.log('═'.repeat(70));

    console.log(`\n  Tasks: ${results.totalTasks}`);
    console.log(`  Completed: ${results.completedTasks} (${results.successRate.toFixed(1)}%)`);
    console.log(`  Budget Exhausted: ${results.budgetExhaustedCount}`);
    console.log(`  Failed: ${results.failedCount}`);
    console.log(`  Budget Violations: ${violations.length}`);
    console.log(`  Budget Enforcement Rate: ${results.budgetEnforcementRate.toFixed(1)}%`);
    console.log(`  Total Cost: $${results.totalCost.toFixed(4)}`);
    console.log(`  Avg Cost/Task: $${results.avgCostPerTask.toFixed(6)}`);
    console.log(`  Total Tokens: ${results.totalTokens}`);
    console.log(`  Avg Tokens/Task: ${results.avgTokensPerTask.toFixed(0)}`);
    console.log(`  Avg Duration: ${results.avgDurationMs.toFixed(0)}ms`);

    console.log('\n── By Complexity ──────────────────────────────────');
    for (const [c, d] of Object.entries(byComplexity)) {
      console.log(`  ${c}: ${d.count} tasks, ${d.completed} completed, avg $${d.avgCost.toFixed(6)}, avg ${d.avgTokens.toFixed(0)} tok, ${d.budgetExhausted} exhausted`);
    }

    console.log('\n── By Budget Level ──────────────────────────────────');
    for (const [b, d] of Object.entries(byBudget)) {
      console.log(`  ${b}: ${d.count} tasks, ${d.completed} completed, avg $${d.avgCost.toFixed(6)}, ${d.budgetExhausted} exhausted, enforcement: ${d.enforcementRate.toFixed(1)}%`);
    }

    console.log('\n── Cost Distribution ──────────────────────────────────');
    for (const b of results.costDistribution) {
      const bar = '█'.repeat(Math.min(40, b.count));
      console.log(`  ${b.bucket.padEnd(12)} ${bar} ${b.count}`);
    }

    console.log('\n── Token Distribution ──────────────────────────────────');
    for (const b of results.tokenDistribution) {
      const bar = '█'.repeat(Math.min(40, b.count));
      console.log(`  ${b.bucket.padEnd(12)} ${bar} ${b.count}`);
    }
  }

  fs.mkdirSync('paper/results', { recursive: true });
  fs.writeFileSync('paper/results/scale-results.json', JSON.stringify(results, null, 2));
  console.log(`\n  Results saved to paper/results/scale-results.json`);
}

main().catch(console.error);
