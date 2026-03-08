/**
 * Guardrails — Constitutional Safety + Approval Workflows
 *
 * Demonstrates Joule's governance features:
 *   - Constitutional rules that block dangerous actions
 *   - Approval policies that require human sign-off
 *   - Budget enforcement that prevents runaway spending
 *
 * This example registers both safe and dangerous tools,
 * then shows how the constitution prevents misuse.
 */

import { Joule } from '@joule/core';
import { z } from 'zod';

async function main() {
  const joule = new Joule({
    // Enable governance with approval workflows
    governance: {
      enabled: true,
    },
    approval: {
      mode: 'automatic',
      policies: [
        {
          name: 'dangerous-tools',
          type: 'tool',
          match: ['delete_files', 'shell_exec'],
          action: 'deny', // Block these tools entirely in this demo
        },
        {
          name: 'cost-gate',
          type: 'cost',
          threshold: 0.10,
          action: 'require_approval',
        },
      ],
    },
  });
  await joule.initialize();

  // Safe tool — always allowed
  joule.registerTool({
    name: 'read_file',
    description: 'Read a file from the project',
    inputSchema: z.object({ path: z.string() }),
    outputSchema: z.any(),
    execute: async ({ path }) => ({
      content: `Contents of ${path}: [sample data]`,
      size: 1024,
    }),
  });

  // Dangerous tool — will be blocked by governance
  joule.registerTool({
    name: 'delete_files',
    description: 'Delete files from the filesystem',
    inputSchema: z.object({ pattern: z.string() }),
    outputSchema: z.any(),
    execute: async ({ pattern }) => {
      // This should never execute due to governance
      return { deleted: 0, pattern };
    },
  });

  // Another dangerous tool — blocked
  joule.registerTool({
    name: 'shell_exec',
    description: 'Execute a shell command',
    inputSchema: z.object({ command: z.string() }),
    outputSchema: z.any(),
    execute: async ({ command }) => {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });

  console.log('--- Guardrails Demo ---\n');

  // Task 1: Safe task — should succeed
  console.log('Task 1: Safe operation (read files)');
  const safeResult = await joule.execute({
    id: 'safe-task',
    description: 'Read the README.md file and summarize it.',
    budget: 'low',
    tools: ['read_file'],
    createdAt: new Date().toISOString(),
  });
  console.log(`  Status: ${safeResult.status}`);
  console.log(`  Cost: $${safeResult.budgetUsed.costUsd.toFixed(4)}`);
  console.log('');

  // Task 2: Dangerous task — governance should block the dangerous tool
  console.log('Task 2: Attempting dangerous operation (delete files)');
  const dangerousResult = await joule.execute({
    id: 'dangerous-task',
    description: 'Delete all temporary files matching *.tmp pattern.',
    budget: 'low',
    tools: ['delete_files'],
    createdAt: new Date().toISOString(),
  });
  console.log(`  Status: ${dangerousResult.status}`);
  console.log(`  Steps: ${dangerousResult.stepResults.length}`);

  // Check if the dangerous tool was actually blocked
  const deleteAttempts = dangerousResult.stepResults.filter(
    s => s.toolName === 'delete_files'
  );
  if (deleteAttempts.length === 0 || deleteAttempts.every(s => !s.success)) {
    console.log('  Governance: Dangerous tool was BLOCKED (as expected)');
  }
  console.log('');

  console.log('--- Summary ---');
  console.log('Safe tasks execute normally.');
  console.log('Dangerous tools are blocked by governance policies.');
  console.log('Budget enforcement prevents runaway spending.');

  await joule.shutdown();
}

main().catch(console.error);
