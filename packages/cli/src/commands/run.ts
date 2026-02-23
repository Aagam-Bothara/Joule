import { Command } from 'commander';
import {
  generateId,
  BUDGET_PRESETS,
  type BudgetPresetName,
  type BudgetEnvelope,
} from '@joule/shared';
import { Joule } from '@joule/core';
import type { ProgressCallback } from '@joule/core';
import { formatResult, formatTrace, formatEfficiencyReport, formatProgressLine, formatBudgetSummary } from '../output/formatter.js';
import { setupJoule } from '../setup.js';

export const runCommand = new Command('run')
  .description('Execute a task')
  .argument('<description>', 'Task description')
  .option('-b, --budget <preset>', 'Budget preset: low, medium, high, unlimited', 'medium')
  .option('--max-tokens <n>', 'Override max tokens', parseInt)
  .option('--max-tool-calls <n>', 'Override max tool calls', parseInt)
  .option('--no-escalate', 'Disable LLM escalation (SLM only)')
  .option('--trace', 'Print full execution trace')
  .option('--json', 'Output as JSON')
  .option('--stream', 'Stream synthesis output in real-time')
  .option('--energy', 'Show energy efficiency report')
  .option('--no-energy', 'Disable energy tracking')
  .action(async (description: string, options) => {
    const joule = new Joule();
    await joule.initialize();
    await setupJoule(joule);

    // Build budget
    let budget: BudgetPresetName | Partial<BudgetEnvelope> = options.budget as BudgetPresetName;
    if (options.maxTokens || options.maxToolCalls || options.escalate === false) {
      const preset = BUDGET_PRESETS[options.budget as BudgetPresetName] ?? BUDGET_PRESETS.medium;
      budget = {
        ...preset,
        ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
        ...(options.maxToolCalls ? { maxToolCalls: options.maxToolCalls } : {}),
        ...(options.escalate === false ? { maxEscalations: 0 } : {}),
      };
    }

    const task = {
      id: generateId('task'),
      description,
      budget,
      createdAt: new Date().toISOString(),
    };

    console.log(`Executing task: "${description}"`);
    console.log(`Budget: ${typeof budget === 'string' ? budget : 'custom'}`);
    console.log('');

    if (options.stream) {
      // Streaming mode
      const onProgress: ProgressCallback = (event) => {
        process.stderr.write(`\r${formatProgressLine(event)}`);
      };

      let finalResult = null;
      for await (const event of joule.executeStream(task, onProgress)) {
        if (event.type === 'progress') {
          process.stderr.write(`\r${formatProgressLine(event.progress!)}`);
        } else if (event.type === 'chunk') {
          // Clear progress line on first chunk
          if (event.chunk && !event.chunk.done) {
            process.stderr.write('\r' + ' '.repeat(80) + '\r');
            process.stdout.write(event.chunk.content);
          }
        } else if (event.type === 'result') {
          finalResult = event.result!;
        }
      }

      console.log(''); // Newline after streamed output
      if (finalResult) {
        console.log('');
        console.log(formatBudgetSummary(finalResult.budgetUsed));
        if (finalResult.efficiencyReport && options.energy !== false) {
          console.log(formatEfficiencyReport(finalResult.efficiencyReport));
        }
        if (options.trace) {
          console.log('');
          console.log('--- Execution Trace ---');
          console.log(formatTrace(finalResult.trace));
        }
      }
    } else {
      // Non-streaming mode
      const onProgress: ProgressCallback = (event) => {
        process.stderr.write(`\r${formatProgressLine(event)}`);
      };

      const result = await joule.execute(task, onProgress);
      process.stderr.write('\r' + ' '.repeat(80) + '\r');

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatResult(result));

        if (result.efficiencyReport && options.energy !== false) {
          console.log(formatEfficiencyReport(result.efficiencyReport));
        }

        if (options.trace) {
          console.log('');
          console.log('--- Execution Trace ---');
          console.log(formatTrace(result.trace));
        }
      }
    }

    await joule.shutdown();
  });
