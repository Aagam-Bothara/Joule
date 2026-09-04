import { Command } from 'commander';
import { Joule, buildTrajectoryFromTrace, renderTrajectory } from '@joule/core';
import { formatErrorForCli } from '@joule/shared';
import { formatTrace } from '../output/formatter.js';

export const traceCommand = new Command('trace')
  .description('View a persisted execution trace (by trace ID or task ID)')
  .argument('<trace-id>', 'Trace ID or task ID')
  .option('--format <format>', 'Output format: trajectory, json', 'trajectory')
  .action(async (traceId: string, options) => {
    let joule: Joule | undefined;
    try {
      joule = new Joule();
      await joule.initialize();
      joule.initializeDatabase();

      const trace = joule.tracer.loadTrace(traceId) ?? joule.tracer.loadTraceByTaskId(traceId);
      if (!trace) {
        console.error(`Trace not found: ${traceId}`);
        console.error(`Hint: traces are persisted when a task runs through the CLI or server; use 'joule run --trace' to print one inline.`);
        process.exitCode = 1;
        return;
      }

      if (options.format === 'json') {
        console.log(formatTrace(trace));
        return;
      }

      const trajectory = buildTrajectoryFromTrace(trace);
      if (trajectory) {
        console.log(renderTrajectory(trajectory));
      } else {
        console.log('No escalation trajectory in this trace (static-router mode). Full trace:');
        console.log(formatTrace(trace));
      }
    } catch (err) {
      console.error(formatErrorForCli(err));
      process.exitCode = 1;
    } finally {
      if (joule) await joule.shutdown();
    }
  });
