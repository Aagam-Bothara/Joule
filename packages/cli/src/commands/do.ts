import { Command } from 'commander';
import { Joule } from '@joule/core';
import { formatWh, formatCarbon } from '../output/formatter.js';
import { setupJoule } from '../setup.js';

export const doCommand = new Command('do')
  .description('Autonomous desktop agent — give it a task and it controls your computer')
  .argument('<task>', 'Natural language task description (e.g. "Open Excel and create a budget spreadsheet")')
  .option('-b, --budget <preset>', 'Budget preset: low, medium, high, unlimited', 'high')
  .option('--max-iterations <n>', 'Max observe-think-act cycles (default: 30)', '30')
  .option('--delay <ms>', 'Milliseconds to wait between actions (default: 1500)', '1500')
  .option('--json', 'Output result as JSON')
  .action(async (task: string, options) => {
    const joule = new Joule();
    await joule.initialize();
    await setupJoule(joule);

    const maxIterations = parseInt(options.maxIterations, 10);
    const screenshotDelay = parseInt(options.delay, 10);

    console.log('');
    console.log('=== Joule Computer Agent ===');
    console.log(`Task: "${task}"`);
    console.log(`Budget: ${options.budget} | Max iterations: ${maxIterations} | Delay: ${screenshotDelay}ms`);
    console.log('');
    console.log('The agent will observe your screen, think, and act autonomously.');
    console.log('Press Ctrl+C to stop at any time.');
    console.log('');

    const startTime = Date.now();

    try {
      const result = await joule.runAgent(task, {
        budget: options.budget,
        maxIterations,
        screenshotDelay,
      });

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('');
        console.log('=== Agent Result ===');
        console.log(`Status:     ${result.success ? 'SUCCESS' : 'INCOMPLETE'}`);
        console.log(`Iterations: ${result.iterations}`);
        console.log(`Actions:    ${result.actions.length}`);
        console.log(`Time:       ${elapsed}s`);
        console.log(`Summary:    ${result.summary}`);
        if (result.validationScore !== undefined) {
          console.log(`Quality:    ${result.validationScore}/10${result.validationSummary ? ` — ${result.validationSummary}` : ''}`);
        }
        console.log('');

        if (result.actions.length > 0) {
          console.log('--- Action Log ---');
          for (const action of result.actions) {
            const status = action.result ? 'OK' : 'FAIL';
            console.log(`  [${action.iteration}] ${action.tool}: ${action.reasoning}`);
          }
          console.log('');
        }

        if (result.budgetUsed) {
          console.log('--- Budget ---');
          console.log(`  Cost:    $${result.budgetUsed.costUsd.toFixed(4)}`);
          console.log(`  Tokens:  ${result.budgetUsed.tokensUsed}`);
          if (result.budgetUsed.energyWh) {
            console.log(`  Energy:  ${formatWh(result.budgetUsed.energyWh)}`);
          }
          if (result.budgetUsed.carbonGrams) {
            console.log(`  Carbon:  ${formatCarbon(result.budgetUsed.carbonGrams)}`);
          }
        }
      }
    } catch (err) {
      console.error(`\nAgent error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    } finally {
      await joule.shutdown();
    }
  });
