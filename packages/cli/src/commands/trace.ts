import { Command } from 'commander';

export const traceCommand = new Command('trace')
  .description('View an execution trace')
  .argument('<trace-id>', 'Trace ID to view')
  .option('--format <format>', 'Output format: json, pretty', 'pretty')
  .action(async (traceId: string, options) => {
    // For now, traces are in-memory only
    // Future: load from file/database
    console.log(`Trace lookup not yet implemented for: ${traceId}`);
    console.log(`Hint: Use 'joule run --trace' to see traces inline.`);
    console.log(`Format: ${options.format}`);
  });
