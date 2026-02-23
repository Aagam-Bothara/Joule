/**
 * Joule Quick Start
 *
 * Minimal example: create a Joule instance, register a custom tool,
 * submit a task, and print the result with energy report.
 */

import { Joule } from '@joule/core';
import { z } from 'zod';

async function main() {
  // 1. Create and initialize Joule
  const joule = new Joule();
  await joule.initialize();

  // 2. Register a custom tool
  joule.registerTool({
    name: 'get_weather',
    description: 'Get the current weather for a city',
    inputSchema: z.object({
      city: z.string().describe('City name'),
    }),
    outputSchema: z.object({
      temperature: z.number(),
      condition: z.string(),
    }),
    execute: async ({ city }) => {
      // Simulated weather data
      const data: Record<string, { temperature: number; condition: string }> = {
        'new york': { temperature: 22, condition: 'Partly Cloudy' },
        'london': { temperature: 15, condition: 'Rainy' },
        'tokyo': { temperature: 28, condition: 'Sunny' },
      };
      return data[city.toLowerCase()] ?? { temperature: 20, condition: 'Unknown' };
    },
  });

  console.log('Joule initialized with tools:', joule.tools.listNames());
  console.log('');

  // 3. Submit a task
  const result = await joule.execute({
    id: 'example-task-1',
    description: 'What is the weather in Tokyo? Use the get_weather tool.',
    budget: 'low',
    createdAt: new Date().toISOString(),
  });

  // 4. Print results
  console.log('--- Task Result ---');
  console.log('Status:', result.status);
  console.log('Answer:', result.result);
  console.log('');

  console.log('--- Steps ---');
  for (const step of result.stepResults) {
    console.log(`  [${step.success ? 'OK' : 'FAIL'}] ${step.description}`);
    if (step.output) console.log('    Output:', JSON.stringify(step.output));
  }
  console.log('');

  console.log('--- Budget Used ---');
  console.log('  Tokens:', result.budgetUsed.tokensUsed);
  console.log('  Cost:  $', result.budgetUsed.costUsd.toFixed(4));
  console.log('  Time:  ', result.budgetUsed.elapsedMs, 'ms');
  console.log('  Energy:', result.budgetUsed.energyWh.toFixed(6), 'Wh');
  console.log('  Carbon:', result.budgetUsed.carbonGrams.toFixed(6), 'g CO2');

  if (result.efficiencyReport) {
    console.log('');
    console.log('--- Energy Efficiency ---');
    console.log('  Energy/Token:', result.efficiencyReport.energyPerToken.toFixed(8), 'Wh');
    console.log('  Carbon/Token:', result.efficiencyReport.carbonPerToken.toFixed(8), 'g');
    console.log('  Rating:      ', result.efficiencyReport.efficiencyRating);
  }

  await joule.shutdown();
}

main().catch(console.error);
