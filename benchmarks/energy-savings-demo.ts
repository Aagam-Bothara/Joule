/**
 * Energy Savings Demo
 *
 * Visual comparison of energy and carbon impact across
 * different Joule budget presets and provider configurations.
 *
 * Usage: npx tsx benchmarks/energy-savings-demo.ts
 */

import {
  BUDGET_PRESETS,
  MODEL_PRICING,
  estimateEnergy,
  calculateCarbon,
  type EnergyConfig,
  type BudgetPresetName,
} from '@joule/shared';

const ENERGY_CONFIG: EnergyConfig = {
  includeInRouting: true,
  gridCarbonIntensity: 475,
  pueOverhead: 1.1,
  reportFormat: 'full',
};

interface SimulatedWorkload {
  name: string;
  tasks: number;
  avgTokensPerTask: number;
  llmFraction: number;
}

const WORKLOADS: SimulatedWorkload[] = [
  { name: 'Light (CLI queries)', tasks: 100, avgTokensPerTask: 800, llmFraction: 0.1 },
  { name: 'Medium (dev assistant)', tasks: 500, avgTokensPerTask: 2000, llmFraction: 0.3 },
  { name: 'Heavy (agent pipeline)', tasks: 2000, avgTokensPerTask: 5000, llmFraction: 0.5 },
];

const SLM_MODEL = 'llama3.2:3b';
const LLM_MODEL = 'claude-3-5-sonnet-20241022';

function simulateWorkload(workload: SimulatedWorkload) {
  let totalEnergyWh = 0;
  let totalCarbonGrams = 0;
  let totalCostUsd = 0;

  for (let i = 0; i < workload.tasks; i++) {
    const useLLM = Math.random() < workload.llmFraction;
    const model = useLLM ? LLM_MODEL : SLM_MODEL;
    const tokens = workload.avgTokensPerTask;
    const inputTokens = Math.floor(tokens * 0.6);
    const outputTokens = tokens - inputTokens;

    const energyWh = estimateEnergy(model, inputTokens, outputTokens);
    const carbonGrams = calculateCarbon(energyWh, model, ENERGY_CONFIG);

    const pricing = MODEL_PRICING[model];
    let cost = 0;
    if (pricing) {
      cost = (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000;
    }

    totalEnergyWh += energyWh;
    totalCarbonGrams += carbonGrams;
    totalCostUsd += cost;
  }

  return { totalEnergyWh, totalCarbonGrams, totalCostUsd };
}

console.log('=== Joule Energy Savings Demo ===\n');
console.log(`Grid carbon intensity: ${ENERGY_CONFIG.gridCarbonIntensity} gCO2/kWh`);
console.log(`PUE overhead: ${ENERGY_CONFIG.pueOverhead}x\n`);

for (const workload of WORKLOADS) {
  console.log(`\n--- Workload: ${workload.name} ---`);
  console.log(`Tasks: ${workload.tasks} | Avg tokens: ${workload.avgTokensPerTask} | LLM fraction: ${(workload.llmFraction * 100).toFixed(0)}%\n`);

  const result = simulateWorkload(workload);

  // Compare with all-LLM baseline
  const allLlmWorkload = { ...workload, llmFraction: 1.0 };
  const allLlm = simulateWorkload(allLlmWorkload);

  const header = `${'Metric'.padEnd(20)} ${'Joule (Adaptive)'.padStart(18)} ${'All-LLM'.padStart(18)} ${'Savings'.padStart(12)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  const energySavings = ((allLlm.totalEnergyWh - result.totalEnergyWh) / allLlm.totalEnergyWh * 100);
  const carbonSavings = ((allLlm.totalCarbonGrams - result.totalCarbonGrams) / allLlm.totalCarbonGrams * 100);
  const costSavings = ((allLlm.totalCostUsd - result.totalCostUsd) / allLlm.totalCostUsd * 100);

  console.log(
    `${'Energy (Wh)'.padEnd(20)} ${result.totalEnergyWh.toFixed(4).padStart(18)} ${allLlm.totalEnergyWh.toFixed(4).padStart(18)} ${(energySavings.toFixed(1) + '%').padStart(12)}`,
  );
  console.log(
    `${'Carbon (gCO2)'.padEnd(20)} ${result.totalCarbonGrams.toFixed(4).padStart(18)} ${allLlm.totalCarbonGrams.toFixed(4).padStart(18)} ${(carbonSavings.toFixed(1) + '%').padStart(12)}`,
  );
  console.log(
    `${'Cost (USD)'.padEnd(20)} ${('$' + result.totalCostUsd.toFixed(4)).padStart(18)} ${('$' + allLlm.totalCostUsd.toFixed(4)).padStart(18)} ${(costSavings.toFixed(1) + '%').padStart(12)}`,
  );
}

// Budget preset comparison
console.log('\n\n=== Budget Presets Energy Limits ===\n');
const presetHeader = `${'Preset'.padEnd(12)} ${'Max Tokens'.padStart(12)} ${'Max Cost'.padStart(10)} ${'Max Energy'.padStart(12)} ${'Max Carbon'.padStart(12)}`;
console.log(presetHeader);
console.log('-'.repeat(presetHeader.length));

for (const [name, preset] of Object.entries(BUDGET_PRESETS)) {
  console.log(
    `${name.padEnd(12)} ${preset.maxTokens.toLocaleString().padStart(12)} ${('$' + preset.costCeilingUsd.toFixed(2)).padStart(10)} ${(preset.maxEnergyWh !== undefined ? preset.maxEnergyWh.toFixed(4) + ' Wh' : 'N/A').padStart(12)} ${(preset.maxCarbonGrams !== undefined ? preset.maxCarbonGrams.toFixed(4) + ' g' : 'N/A').padStart(12)}`,
  );
}
