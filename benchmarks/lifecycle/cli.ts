/**
 * Lifecycle characterization CLI.
 *
 *   npx tsx benchmarks/lifecycle/cli.ts collect                       # harness reports -> runs.jsonl
 *   npx tsx benchmarks/lifecycle/cli.ts collect --reports <dir> --out <file>
 *   npx tsx benchmarks/lifecycle/cli.ts analyze                       # runs.jsonl -> report + summary.json
 *   npx tsx benchmarks/lifecycle/cli.ts analyze <runs.jsonl|harness-report.json> [--out-dir <dir>] [--json]
 *
 * `collect` turns benchmark reports into one record per agent run; `analyze`
 * aggregates them and writes workflows.jsonl and summary.json next to the
 * input. Datasets live under benchmarks/experiments/ and are gitignored, the
 * same way benchmarks/reports/ is.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { analyzeRecords, renderLifecycleReport } from './analyze.js';
import { parseJsonl, recordsFromHarnessReport, toJsonl } from './record.js';
import type { AgentLifecycleRecord } from './types.js';

const REPORTS_DIR = join('benchmarks', 'reports');
const EXPERIMENTS_DIR = join('benchmarks', 'experiments', 'lifecycle');
const DEFAULT_RUNS = join(EXPERIMENTS_DIR, 'runs.jsonl');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Records from every harness report in `dir` (one runId per report file). */
function collect(dir: string, label?: string): AgentLifecycleRecord[] {
  if (!existsSync(dir)) throw new Error(`No reports directory at ${dir}`);
  const files = readdirSync(dir)
    .filter(f => f.startsWith('harness-') && f.endsWith('.json'))
    .filter(f => (label ? f.includes(label) : true))
    .sort();
  const records: AgentLifecycleRecord[] = [];
  let withLifecycle = 0;
  for (const file of files) {
    const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    const found = recordsFromHarnessReport(report, basename(file, '.json'));
    if (found.length > 0) withLifecycle++;
    records.push(...found);
  }
  process.stderr.write(`scanned ${files.length} report(s), ${withLifecycle} with lifecycle data\n`);
  return records;
}

function loadRecords(file: string): AgentLifecycleRecord[] {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) return parseJsonl<AgentLifecycleRecord>(text);
  // A harness report can be analyzed directly, without collecting first.
  return recordsFromHarnessReport(JSON.parse(text) as unknown, basename(file, '.json'));
}

function main(): void {
  const command = process.argv[2] ?? 'analyze';

  if (command === 'collect') {
    const dir = arg('--reports') ?? REPORTS_DIR;
    const out = arg('--out') ?? DEFAULT_RUNS;
    const records = collect(dir, arg('--label'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, toJsonl(records));
    process.stderr.write(`${records.length} record(s) written to ${out}\n`);
    return;
  }

  if (command !== 'analyze') {
    process.stderr.write(`Unknown command: ${command}\nUsage: cli.ts [collect|analyze] [file] [options]\n`);
    process.exitCode = 1;
    return;
  }

  const positional = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  const input = positional ?? DEFAULT_RUNS;
  if (!existsSync(input)) {
    process.stderr.write(`No dataset at ${input}. Run "collect" first, or pass a harness report.\n`);
    process.exitCode = 1;
    return;
  }

  const records = loadRecords(input);
  const analysis = analyzeRecords(records, input);
  const outDir = arg('--out-dir') ?? dirname(input);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'workflows.jsonl'), analysis.workflows.map(w => JSON.stringify(w)).join('\n') + (analysis.workflows.length > 0 ? '\n' : ''));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(analysis, null, 2));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    console.log(renderLifecycleReport(analysis));
    console.log('');
    console.log(`Workflows written to ${join(outDir, 'workflows.jsonl')}`);
    console.log(`Summary written to   ${join(outDir, 'summary.json')}`);
  }
}

main();
