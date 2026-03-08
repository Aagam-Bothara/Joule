/**
 * Research Crew — Multi-Agent Orchestration
 *
 * Demonstrates a crew of 3 agents working together:
 *   1. Researcher — gathers raw information
 *   2. Analyst — synthesizes and finds patterns
 *   3. Writer — produces the final summary
 *
 * Each agent gets its own budget slice. The crew stays within total cost limits.
 */

import { Joule } from '@joule/core';
import { z } from 'zod';

async function main() {
  const joule = new Joule();
  await joule.initialize();

  // Register tools the crew will use
  joule.registerTool({
    name: 'web_search',
    description: 'Search the web for information',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
    }),
    outputSchema: z.any(),
    execute: async ({ query }) => ({
      results: [
        { title: `Result 1 for "${query}"`, snippet: `Detailed findings about ${query} from authoritative source.` },
        { title: `Result 2 for "${query}"`, snippet: `Additional perspective on ${query} with data points.` },
        { title: `Result 3 for "${query}"`, snippet: `Expert analysis of ${query} trends and implications.` },
      ],
    }),
  });

  joule.registerTool({
    name: 'save_report',
    description: 'Save the final research report',
    inputSchema: z.object({
      title: z.string(),
      content: z.string(),
    }),
    outputSchema: z.any(),
    execute: async ({ title, content }) => {
      console.log(`\n--- Report Saved: "${title}" ---`);
      console.log(content.slice(0, 500) + (content.length > 500 ? '...' : ''));
      return { saved: true, title };
    },
  });

  console.log('--- Research Crew Demo ---\n');
  console.log('Running a 3-agent crew: Researcher → Analyst → Writer\n');

  // Execute using a pre-built crew template
  // This runs agents sequentially — each builds on the previous output
  const result = await joule.execute({
    id: 'research-crew-demo',
    description: [
      'Research the current state of AI agent frameworks.',
      'Compare the top 3 frameworks by features, cost, and community size.',
      'Write a concise 2-paragraph summary with recommendations.',
    ].join(' '),
    budget: 'medium',
    createdAt: new Date().toISOString(),
  });

  console.log('\n--- Crew Result ---');
  console.log('Status:', result.status);
  console.log('Steps completed:', result.stepResults.length);
  console.log('');

  for (const step of result.stepResults) {
    console.log(`  [${step.success ? 'OK' : 'FAIL'}] ${step.toolName}: ${step.description}`);
  }

  console.log('');
  console.log('--- Cost Breakdown ---');
  console.log(`  Total tokens: ${result.budgetUsed.tokensUsed}`);
  console.log(`  Total cost:   $${result.budgetUsed.costUsd.toFixed(4)}`);

  await joule.shutdown();
}

main().catch(console.error);
