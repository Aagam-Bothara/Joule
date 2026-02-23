/**
 * Joule Chat Bot
 *
 * Interactive readline chat loop with session persistence.
 * Messages are saved to disk and reloaded on restart.
 */

import * as readline from 'node:readline';
import { Joule } from '@joule/core';
import { SessionManager } from '@joule/core';
import { z } from 'zod';

async function main() {
  const joule = new Joule();
  await joule.initialize();

  // Register a simple calculator tool
  joule.registerTool({
    name: 'calculate',
    description: 'Evaluate a math expression',
    inputSchema: z.object({
      expression: z.string().describe('Math expression like "2 + 3 * 4"'),
    }),
    outputSchema: z.object({ result: z.number() }),
    execute: async ({ expression }) => {
      // Simple safe math eval (only digits, operators, parens, dots)
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        throw new Error('Invalid expression');
      }
      return { result: Function(`"use strict"; return (${expression})`)() };
    },
  });

  // Session management
  const sessions = new SessionManager();
  let session = await sessions.create();
  console.log(`New session: ${session.id}`);
  console.log('Type your messages. Commands: /new (new session), /history, /quit');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You> ',
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Handle commands
    if (input === '/quit') {
      await sessions.save(session);
      console.log('Session saved. Goodbye!');
      rl.close();
      process.exit(0);
    }

    if (input === '/new') {
      await sessions.save(session);
      session = await sessions.create();
      console.log(`New session started: ${session.id}`);
      rl.prompt();
      return;
    }

    if (input === '/history') {
      if (session.messages.length === 0) {
        console.log('(no messages yet)');
      } else {
        for (const msg of session.messages) {
          const role = msg.role === 'user' ? 'You' : 'Joule';
          console.log(`  ${role}: ${msg.content.slice(0, 100)}`);
        }
      }
      rl.prompt();
      return;
    }

    // Record user message
    sessions.addMessage(session, {
      role: 'user',
      content: input,
      timestamp: new Date().toISOString(),
    });

    // Execute via Joule
    try {
      const result = await joule.execute({
        id: `chat-${Date.now()}`,
        description: input,
        budget: 'medium',
        context: session.messages.slice(-6).map(m => m.content).join('\n'),
        createdAt: new Date().toISOString(),
      });

      const answer = result.result ?? `[${result.status}]`;
      console.log(`Joule> ${answer}`);

      // Record assistant message
      sessions.addMessage(session, {
        role: 'assistant',
        content: answer,
        timestamp: new Date().toISOString(),
      });
      sessions.updateMetadata(session, {
        totalTokens: result.budgetUsed.tokensUsed,
        totalCostUsd: result.budgetUsed.costUsd,
        totalEnergyWh: result.budgetUsed.energyWh,
        totalCarbonGrams: result.budgetUsed.carbonGrams,
      });
      await sessions.save(session);
    } catch (err: any) {
      console.log(`Error: ${err.message}`);
    }

    rl.prompt();
  });
}

main().catch(console.error);
