/**
 * Budget-Constrained Execution
 *
 * Demonstrates Joule's 7-dimensional budget enforcement.
 * The agent is given a task with a strict cost cap — it completes
 * as much as possible within the budget, then stops cleanly.
 */

import { Joule } from '@joule/core';
import { z } from 'zod';

async function main() {
  const joule = new Joule({
    // Use whatever provider is available
    routing: { preferLocal: true },
  });
  await joule.initialize();

  // Register a tool that simulates API calls with varying cost
  joule.registerTool({
    name: 'search_news',
    description: 'Search recent news articles on a topic',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      maxResults: z.number().default(5).describe('Max articles to return'),
    }),
    outputSchema: z.any(),
    execute: async ({ query, maxResults }) => {
      // Simulated search results
      const articles = Array.from({ length: maxResults }, (_, i) => ({
        title: `${query} — Article ${i + 1}`,
        summary: `Key findings about ${query} from source ${i + 1}.`,
        source: `source-${i + 1}.com`,
      }));
      return { articles, count: articles.length };
    },
  });

  console.log('--- Budget-Constrained Execution ---\n');

  // Execute with a LOW budget — strict limits
  const result = await joule.execute({
    id: 'budget-demo',
    description: 'Search for the latest news about AI agents, then summarize the top 3 findings.',
    budget: 'low',  // Low budget: 10K tokens, $0.05 max
    createdAt: new Date().toISOString(),
  });

  console.log('Status:', result.status);
  console.log('Result:', result.result);
  console.log('');

  // Show exactly how much was spent across all 7 dimensions
  console.log('--- Budget Report (7 Dimensions) ---');
  const b = result.budgetUsed;
  console.log(`  Tokens:      ${b.tokensUsed} used / ${b.tokensRemaining + b.tokensUsed} allocated`);
  console.log(`  Cost:        $${b.costUsd.toFixed(4)}`);
  console.log(`  Time:        ${b.elapsedMs}ms`);
  console.log(`  Tool calls:  ${b.toolCallsUsed}`);
  console.log(`  Escalations: ${b.escalationsUsed}`);
  console.log(`  Energy:      ${b.energyWh.toFixed(6)} Wh`);
  console.log(`  Carbon:      ${b.carbonGrams.toFixed(6)} g CO₂`);

  if (result.efficiencyReport) {
    console.log('');
    console.log('--- Efficiency ---');
    console.log(`  Energy/token: ${result.efficiencyReport.energyPerToken.toFixed(8)} Wh`);
    console.log(`  Rating:       ${result.efficiencyReport.efficiencyRating}`);
  }

  await joule.shutdown();
}

main().catch(console.error);
