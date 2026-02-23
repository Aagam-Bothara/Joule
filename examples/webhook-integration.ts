/**
 * Joule Webhook Integration
 *
 * Sets up an HTTP server that receives webhook POSTs,
 * routes them through Joule for processing, and returns
 * the AI-generated response.
 */

import * as http from 'node:http';
import { Joule } from '@joule/core';
import { z } from 'zod';

const PORT = 3950;

async function main() {
  const joule = new Joule();
  await joule.initialize();

  // Register domain-specific tools
  joule.registerTool({
    name: 'lookup_order',
    description: 'Look up an order by ID',
    inputSchema: z.object({
      orderId: z.string().describe('The order ID to look up'),
    }),
    outputSchema: z.object({
      orderId: z.string(),
      status: z.string(),
      items: z.array(z.string()),
      total: z.number(),
    }),
    execute: async ({ orderId }) => {
      // Simulated order database
      return {
        orderId,
        status: 'shipped',
        items: ['Widget A', 'Gadget B'],
        total: 49.99,
      };
    },
  });

  joule.registerTool({
    name: 'create_ticket',
    description: 'Create a support ticket',
    inputSchema: z.object({
      subject: z.string(),
      priority: z.enum(['low', 'medium', 'high']),
    }),
    outputSchema: z.object({ ticketId: z.string() }),
    execute: async ({ subject, priority }) => {
      const ticketId = `TKT-${Date.now()}`;
      console.log(`  [Ticket Created] ${ticketId}: ${subject} (${priority})`);
      return { ticketId };
    },
  });

  // Create HTTP server
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. POST to /webhook' }));
      return;
    }

    // Read request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());

    console.log(`\nReceived webhook: ${JSON.stringify(body)}`);

    // Process through Joule
    const result = await joule.execute({
      id: `webhook-${Date.now()}`,
      description: body.message ?? body.text ?? JSON.stringify(body),
      budget: 'low',
      tools: ['lookup_order', 'create_ticket'],
      createdAt: new Date().toISOString(),
    });

    const response = {
      status: result.status,
      response: result.result,
      stepsExecuted: result.stepResults.length,
      budgetUsed: {
        tokens: result.budgetUsed.tokensUsed,
        cost: result.budgetUsed.costUsd,
        energy: result.budgetUsed.energyWh,
      },
    };

    console.log(`Response: ${result.status} (${result.budgetUsed.tokensUsed} tokens)`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response, null, 2));
  });

  server.listen(PORT, () => {
    console.log(`Webhook server listening on http://localhost:${PORT}`);
    console.log('');
    console.log('Test with:');
    console.log(`  curl -X POST http://localhost:${PORT}/webhook \\`);
    console.log('    -H "Content-Type: application/json" \\');
    console.log('    -d \'{"message": "What is the status of order ORD-123?"}\'');
    console.log('');
    console.log('  curl -X POST http://localhost:${PORT}/webhook \\');
    console.log('    -H "Content-Type: application/json" \\');
    console.log('    -d \'{"message": "Create a high priority ticket: Server is down"}\'');
  });
}

main().catch(console.error);
