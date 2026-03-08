/**
 * joule replay <task-id> — re-run a past task with different parameters, diff outputs.
 *
 * Usage:
 *   joule replay task_abc123 --budget high --diff
 *   joule replay task_abc123 --json
 */

import { Command } from 'commander';
import { Joule } from '@joule/core';
import { replayTask } from '@joule/core';
import { setupJoule } from '../setup.js';
import { formatReplayDiff, formatReplayDiffJson } from '../output/diff-formatter.js';

export const replayCommand = new Command('replay')
  .description('Re-run a past task with different parameters and diff the outputs')
  .argument('<task-id>', 'ID of the original task to replay')
  .option('--budget <preset>', 'Override budget preset (low/medium/high/unlimited)')
  .option('--diff', 'Show detailed diff output (default: true)', true)
  .option('--json', 'Output diff as JSON')
  .action(async (taskId: string, opts) => {
    try {
      const joule = new Joule();
      await setupJoule(joule);
      await joule.initialize();

      console.log(`\nReplaying task ${taskId}...`);
      if (opts.budget) console.log(`  Budget override: ${opts.budget}`);
      console.log('');

      const result = await replayTask(joule, {
        originalTaskId: taskId,
        overrides: {
          budget: opts.budget,
        },
      });

      if (opts.json) {
        console.log(formatReplayDiffJson(result.diff));
      } else {
        // Summary
        console.log(`Original: ${result.original.description}`);
        console.log(`  Status: ${result.original.status} | Steps: ${result.original.stepCount} | Tokens: ${result.original.budgetUsed?.tokensUsed ?? '—'}`);
        console.log('');
        console.log(`Replay:   ${result.replay.taskId}`);
        console.log(`  Status: ${result.replay.status} | Steps: ${result.replay.stepCount} | Tokens: ${result.replay.budgetUsed?.tokensUsed ?? '—'}`);
        console.log('');

        if (opts.diff) {
          console.log(formatReplayDiff(result.diff));
        }
      }

      await joule.shutdown();
    } catch (err) {
      console.error(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });
