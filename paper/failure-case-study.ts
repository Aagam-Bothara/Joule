/**
 * Failure Case Study: Runaway Agent Without Budget Enforcement
 * =============================================================
 * Demonstrates what happens when an AI agent has no budget limits vs
 * when Joule's budget enforcement is active.
 *
 * Usage:
 *   npx tsx paper/failure-case-study.ts
 *   npx tsx paper/failure-case-study.ts --json
 */

import { Joule } from '@joule/core';
import { BUDGET_PRESETS } from '@joule/shared';
import type { Task } from '@joule/shared';
import { z } from 'zod';
import * as fs from 'fs';
import {
  createMockProvider,
  VERBOSE_UNIFIED_RESPONSES,
  BASE_JOULE_CONFIG,
  generateId,
} from './shared-mock.js';

interface CaseResult {
  scenario: string;
  status: string;
  tokensUsed: number;
  costUsd: number;
  toolCalls: number;
  escalations: number;
  durationMs: number;
  steps: number;
  budgetExhausted: boolean;
  stoppedByBudget: boolean;
}

async function runScenario(name: string, budget: string, tokenMultiplier: number): Promise<CaseResult> {
  const joule = new Joule({
    ...BASE_JOULE_CONFIG,
    budgetPreset: budget,
    routing: {
      ...BASE_JOULE_CONFIG.routing,
      defaultTier: 'llm',
      escalationThreshold: 0.3,
    },
  });
  await joule.initialize();

  // Use high token counts: unlimited consumes many tokens,
  // lower budgets hit ceilings at different points
  const provider = createMockProvider(VERBOSE_UNIFIED_RESPONSES, {
    slmLatency: 5,
    llmLatency: 15,
    slmTokens: Math.floor(5000 * tokenMultiplier),
    llmTokens: Math.floor(10000 * tokenMultiplier),
    forceTier: 'llm',
  });
  joule.providers.register(provider as any);

  joule.registerTool({
    name: 'bench_tool',
    description: 'A benchmark tool',
    inputSchema: z.object({ input: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async (args: any) => ({ result: `done: ${args.input ?? 'default'}` }),
  });

  const task: Task = {
    id: generateId('fail'),
    description: "Research the complete history of artificial intelligence from the 1950s to present day, analyze every major breakthrough, compare all major AI frameworks, evaluate their performance across 20 dimensions, and write a 10-section comprehensive report with citations and recommendations for the next decade.",
    budget: budget as any,
    createdAt: new Date().toISOString(),
  };

  const start = performance.now();
  try {
    const result = await joule.execute(task);
    const durationMs = Math.round(performance.now() - start);
    await joule.shutdown();

    return {
      scenario: name,
      status: result.status,
      tokensUsed: result.budgetUsed?.tokensUsed ?? 0,
      costUsd: result.budgetUsed?.costUsd ?? 0,
      toolCalls: result.budgetUsed?.toolCallsUsed ?? 0,
      escalations: result.budgetUsed?.escalationsUsed ?? 0,
      durationMs,
      steps: result.stepResults?.length ?? 0,
      budgetExhausted: result.status === 'budget_exhausted',
      stoppedByBudget: result.status === 'budget_exhausted',
    };
  } catch (err: any) {
    await joule.shutdown();
    return {
      scenario: name,
      status: 'error',
      tokensUsed: 0,
      costUsd: 0,
      toolCalls: 0,
      escalations: 0,
      durationMs: Math.round(performance.now() - start),
      steps: 0,
      budgetExhausted: false,
      stoppedByBudget: false,
    };
  }
}

async function main() {
  const jsonOutput = process.argv.includes('--json');

  console.log('\n' + '═'.repeat(70));
  console.log('  FAILURE CASE STUDY: Runaway Agent vs Budget Enforcement');
  console.log('═'.repeat(70));

  // Scenario 1: Unlimited budget (simulates no enforcement)
  console.log('\n── Scenario 1: Unlimited Budget (No Enforcement) ──');
  console.log('  Running verbose agent with unlimited budget...');
  const unlimited = await runScenario('unlimited-budget', 'unlimited', 3);
  console.log(`  Status: ${unlimited.status}`);
  console.log(`  Tokens: ${unlimited.tokensUsed} | Cost: $${unlimited.costUsd.toFixed(4)} | Tools: ${unlimited.toolCalls} | Steps: ${unlimited.steps}`);

  // Scenario 2: High budget
  console.log('\n── Scenario 2: High Budget ──');
  console.log('  Running same agent with HIGH budget ($1.00, 100K tokens)...');
  const high = await runScenario('high-budget', 'high', 3);
  console.log(`  Status: ${high.status}`);
  console.log(`  Tokens: ${high.tokensUsed} | Cost: $${high.costUsd.toFixed(4)} | Tools: ${high.toolCalls} | Steps: ${high.steps}`);
  console.log(`  Stopped by budget: ${high.stoppedByBudget}`);

  // Scenario 3: Medium budget
  console.log('\n── Scenario 3: Medium Budget ──');
  console.log('  Running same agent with MEDIUM budget ($0.10, 16K tokens)...');
  const medium = await runScenario('medium-budget', 'medium', 3);
  console.log(`  Status: ${medium.status}`);
  console.log(`  Tokens: ${medium.tokensUsed} | Cost: $${medium.costUsd.toFixed(4)} | Tools: ${medium.toolCalls} | Steps: ${medium.steps}`);
  console.log(`  Stopped by budget: ${medium.stoppedByBudget}`);

  // Scenario 4: Low budget (strict enforcement)
  console.log('\n── Scenario 4: Low Budget (Strict Enforcement) ──');
  console.log('  Running same agent with LOW budget ($0.01, 4K tokens)...');
  const low = await runScenario('low-budget', 'low', 3);
  console.log(`  Status: ${low.status}`);
  console.log(`  Tokens: ${low.tokensUsed} | Cost: $${low.costUsd.toFixed(4)} | Tools: ${low.toolCalls} | Steps: ${low.steps}`);
  console.log(`  Stopped by budget: ${low.stoppedByBudget}`);

  // Summary
  const results = [unlimited, high, medium, low];

  console.log('\n' + '═'.repeat(70));
  console.log('  COMPARISON TABLE');
  console.log('═'.repeat(70));
  console.log(`\n  ${'Scenario'.padEnd(22)} ${'Status'.padEnd(18)} ${'Tokens'.padStart(8)} ${'Cost'.padStart(10)} ${'Tools'.padStart(6)} ${'Steps'.padStart(6)} ${'Stopped'.padStart(8)}`);
  console.log(`  ${'─'.repeat(22)} ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);
  for (const r of results) {
    console.log(`  ${r.scenario.padEnd(22)} ${r.status.padEnd(18)} ${String(r.tokensUsed).padStart(8)} $${r.costUsd.toFixed(4).padStart(9)} ${String(r.toolCalls).padStart(6)} ${String(r.steps).padStart(6)} ${String(r.stoppedByBudget).padStart(8)}`);
  }

  // Key findings
  console.log('\n── KEY FINDINGS ──');
  if (unlimited.tokensUsed > 0 && low.tokensUsed >= 0) {
    const tokenReduction = unlimited.tokensUsed > 0
      ? ((unlimited.tokensUsed - low.tokensUsed) / unlimited.tokensUsed * 100).toFixed(1)
      : 'N/A';
    const costReduction = unlimited.costUsd > 0
      ? ((unlimited.costUsd - low.costUsd) / unlimited.costUsd * 100).toFixed(1)
      : 'N/A';
    console.log(`  Token reduction (unlimited → low): ${tokenReduction}%`);
    console.log(`  Cost reduction (unlimited → low): ${costReduction}%`);
    console.log(`  Budget enforcement prevented runaway: ${low.stoppedByBudget ? 'YES' : low.tokensUsed < unlimited.tokensUsed ? 'YES (capped)' : 'NO'}`);
  }

  // Save
  fs.mkdirSync('paper/results', { recursive: true });
  fs.writeFileSync('paper/results/failure-case-study.json', JSON.stringify({
    scenarios: results,
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log(`\n  Results saved to paper/results/failure-case-study.json`);
}

main().catch(console.error);
