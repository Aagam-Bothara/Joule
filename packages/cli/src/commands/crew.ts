import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  generateId,
  type BudgetPresetName,
  type CrewDefinition,
} from '@joule/shared';
import { Joule } from '@joule/core';
import type { ProgressCallback } from '@joule/core';
import { formatProgressLine, formatBudgetSummary, formatEfficiencyReport } from '../output/formatter.js';
import { setupJoule } from '../setup.js';

export const crewCommand = new Command('crew')
  .description('Multi-agent crew orchestration');

// --- joule crew run ---
crewCommand
  .command('run')
  .description('Execute a multi-agent crew')
  .argument('<task>', 'Task description for the crew')
  .requiredOption('-c, --config <path>', 'Path to crew definition JSON file')
  .option('-b, --budget <preset>', 'Override crew budget preset')
  .option('--trace', 'Print full execution trace')
  .option('--json', 'Output as JSON')
  .option('--energy', 'Show energy efficiency report')
  .action(async (taskDescription: string, options: {
    config: string;
    budget?: string;
    trace?: boolean;
    json?: boolean;
    energy?: boolean;
  }) => {
    const joule = new Joule();
    await joule.initialize();
    await setupJoule(joule);

    // Load crew definition
    const configPath = path.resolve(options.config);
    let configContent: string;
    try {
      configContent = await fs.readFile(configPath, 'utf-8');
    } catch {
      console.error(`Error: Cannot read crew config at ${configPath}`);
      process.exit(1);
    }

    let crew: CrewDefinition;
    try {
      crew = JSON.parse(configContent) as CrewDefinition;
    } catch {
      console.error('Error: Invalid JSON in crew config');
      process.exit(1);
    }

    // Override budget if specified
    if (options.budget) {
      crew.budget = options.budget as BudgetPresetName;
    }

    const task = {
      id: generateId('task'),
      description: taskDescription,
      createdAt: new Date().toISOString(),
    };

    console.log(`\n=== Joule Crew: ${crew.name} ===`);
    console.log(`Strategy: ${crew.strategy}`);
    const agentModes = crew.agents.map((a: { id: string; role: string; executionMode?: string }) =>
      `${a.id} (${a.role}) [${a.executionMode ?? 'direct'}]`
    );
    console.log(`Agents: ${agentModes.join(', ')}`);
    console.log(`Task: "${taskDescription}"`);
    console.log('');

    const onProgress: ProgressCallback = (event) => {
      const agentPrefix = event.agentId ? `[${event.agentRole ?? event.agentId}] ` : '';
      process.stderr.write(`\r${agentPrefix}${formatProgressLine(event)}`);
    };

    try {
      const result = await joule.executeCrew(crew, task, onProgress);
      process.stderr.write('\r' + ' '.repeat(80) + '\r');

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\n=== Crew Result ===`);
        console.log(`Status: ${result.status}`);
        console.log(`Agents completed: ${result.agentResults.filter(a => a.taskResult.status === 'completed').length}/${result.agentResults.length}`);
        console.log('');

        // Print per-agent results
        for (const agentResult of result.agentResults) {
          console.log(`--- ${agentResult.role} (${agentResult.agentId}) ---`);
          console.log(`Status: ${agentResult.taskResult.status}`);
          console.log(`Result: ${(agentResult.taskResult.result ?? 'No output').slice(0, 300)}`);
          console.log(`Budget: $${agentResult.budgetUsed.costUsd.toFixed(4)} | ${agentResult.budgetUsed.tokensUsed} tokens`);
          console.log('');
        }

        // Print blackboard status
        const bbEntries = Object.entries(result.blackboard.entries);
        if (bbEntries.length > 0) {
          console.log('--- Blackboard ---');
          for (const [key, entry] of bbEntries) {
            const statusTag = entry.status ? `[${entry.status}]` : '';
            const metaTag = entry.metadata?.tags ? ` tags: ${entry.metadata.tags.join(', ')}` : '';
            console.log(`  ${key} ${statusTag}${metaTag}`);
          }
          console.log('');
        }

        // Print aggregated result
        console.log('--- Final Result ---');
        console.log(result.result ?? 'No aggregated result');
        console.log('');

        // Budget summary
        console.log(formatBudgetSummary(result.budgetUsed));

        if (result.efficiencyReport && options.energy !== false) {
          console.log(formatEfficiencyReport(result.efficiencyReport));
        }

        if (options.trace) {
          console.log('\n--- Execution Trace ---');
          for (const span of result.trace.spans) {
            const duration = (span.endTime ?? 0) - span.startTime;
            console.log(`  ${span.name}: ${duration}ms`);
          }
        }
      }
    } catch (err) {
      console.error(`\nCrew error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      await joule.shutdown();
    }
  });

// --- joule crew list ---
crewCommand
  .command('list')
  .description('List agents in a crew configuration')
  .argument('<config>', 'Path to crew definition JSON file')
  .action(async (configPath: string) => {
    const resolvedPath = path.resolve(configPath);
    let configContent: string;
    try {
      configContent = await fs.readFile(resolvedPath, 'utf-8');
    } catch {
      console.error(`Error: Cannot read crew config at ${resolvedPath}`);
      process.exit(1);
    }

    const crew = JSON.parse(configContent) as CrewDefinition;

    console.log(`\nCrew: ${crew.name}`);
    console.log(`Strategy: ${crew.strategy}`);
    console.log(`Description: ${crew.description ?? 'N/A'}`);
    console.log('');
    console.log('Agents:');
    for (const agent of crew.agents) {
      const tools = agent.allowedTools?.join(', ') ?? 'all';
      const budget = agent.budgetShare !== undefined
        ? `${(agent.budgetShare * 100).toFixed(0)}%`
        : 'equal';
      console.log(`  ${agent.id} (${agent.role})`);
      console.log(`    Tools: ${tools}`);
      console.log(`    Budget: ${budget}`);
      console.log(`    Memory: ${agent.memoryMode ?? 'shared'}`);
      console.log(`    Mode: ${agent.executionMode ?? 'direct'}`);
      if (agent.maxRetries) console.log(`    Retry: ${agent.maxRetries}x (${agent.retryDelayMs ?? 1000}ms base)`);
      if (agent.maxIterations) console.log(`    Max Iterations: ${agent.maxIterations}`);
      if (agent.outputSchema) console.log(`    Output Schema: ${JSON.stringify(Object.keys((agent.outputSchema as any).properties ?? {}))}`);
    }
  });
