/**
 * Crew-scaling experiment CLI.
 *
 *   npx tsx benchmarks/crew-scaling/cli.ts run --widths 1,2,3,4 --tasks 10 --offset 100
 *   npx tsx benchmarks/crew-scaling/cli.ts analyze
 *
 * `run` executes the same tasks at each crew width and writes runs.jsonl plus a
 * manifest; `analyze` reads that file. Measurement only — no crew is resized
 * anywhere in Joule.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonl } from '../lifecycle/record.js';
import { analyzeCrewScaling, renderCrewScalingReport } from './analyze.js';
import { runCrewScaling } from './runner.js';
import type { CrewScalingRecord, CrewWidth } from './types.js';

const DEFAULT_DIR = join('benchmarks', 'experiments', 'crew-scaling');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'analyze';
  const outDir = arg('--out-dir') ?? DEFAULT_DIR;

  if (command === 'run') {
    const widths = (arg('--widths') ?? '1,2,3,4').split(',').map(Number) as CrewWidth[];
    const records = await runCrewScaling({
      widths,
      tasks: Number(arg('--tasks') ?? '10'),
      offset: Number(arg('--offset') ?? '100'),
      provider: arg('--provider') ?? process.env.JOULE_LIFECYCLE_PROVIDER ?? 'openrouter',
      model: arg('--model') ?? process.env.JOULE_LIFECYCLE_MODEL ?? 'deepseek/deepseek-v4-flash',
      outDir,
      label: arg('--label') ?? 'crew-scaling',
    });
    const spend = records.reduce((s, r) => s + r.totalCostUsd, 0);
    process.stderr.write(`\n${records.length} run(s), $${spend.toFixed(4)} spent, written to ${join(outDir, 'runs.jsonl')}\n`);
    return;
  }

  if (command !== 'analyze') {
    process.stderr.write(`Unknown command: ${command}\nUsage: cli.ts [run|analyze] [options]\n`);
    process.exitCode = 1;
    return;
  }

  const input = arg('--input') ?? join(outDir, 'runs.jsonl');
  if (!existsSync(input)) {
    process.stderr.write(`No dataset at ${input}. Run "run" first.\n`);
    process.exitCode = 1;
    return;
  }
  const records = parseJsonl<CrewScalingRecord>(readFileSync(input, 'utf8'));
  const analysis = analyzeCrewScaling(records, input);
  mkdirSync(dirname(input), { recursive: true });
  writeFileSync(join(dirname(input), 'summary.json'), JSON.stringify(analysis, null, 2));
  writeFileSync(join(dirname(input), 'paired-analysis.json'), JSON.stringify({
    marginal: analysis.marginal,
    dominance: analysis.dominance,
    minimumWidth: analysis.minimumWidth,
    oracle: analysis.oracle,
  }, null, 2));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    console.log(renderCrewScalingReport(analysis));
    console.log('');
    console.log(`Summary written to ${join(dirname(input), 'summary.json')}`);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
