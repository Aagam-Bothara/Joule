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

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { analyzeRecords, renderAgentBands, renderLifecycleReport, summarizeWorkflows } from './analyze.js';
import { parseJsonl, recordsFromHarnessReport, toJsonl } from './record.js';
import { renderValidation, validateRecords } from './validate.js';
import type { AgentLifecycleRecord } from './types.js';

const REPORTS_DIR = join('benchmarks', 'reports');
const EXPERIMENTS_DIR = join('benchmarks', 'experiments', 'lifecycle');
const DEFAULT_RUNS = join(EXPERIMENTS_DIR, 'runs.jsonl');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** What a report contributed, for the manifest. */
interface CollectedSource {
  file: string;
  workload?: string;
  timestamp?: string;
  models?: unknown;
  records: number;
}

/** Records from every harness report in `dir` (one runId per report file). */
function collect(dir: string, label?: string): { records: AgentLifecycleRecord[]; sources: CollectedSource[] } {
  if (!existsSync(dir)) throw new Error(`No reports directory at ${dir}`);
  const files = readdirSync(dir)
    .filter(f => f.startsWith('harness-') && f.endsWith('.json'))
    // The timestamp must follow the label, so "real-single" does not also
    // match "real-single-sanity".
    .filter(f => (label ? f.includes(`-${label}-20`) : true))
    .sort();
  const records: AgentLifecycleRecord[] = [];
  const sources: CollectedSource[] = [];
  for (const file of files) {
    const report = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { workload?: string; timestamp?: string; models?: unknown };
    const found = recordsFromHarnessReport(report, basename(file, '.json'));
    if (found.length === 0) continue;
    records.push(...found);
    sources.push({ file, workload: report.workload, timestamp: report.timestamp, models: report.models, records: found.length });
  }
  process.stderr.write(`scanned ${files.length} report(s), ${sources.length} with lifecycle data\n`);
  return { records, sources };
}

function gitCommit(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
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
    const outDir = arg('--out-dir') ?? EXPERIMENTS_DIR;
    const out = arg('--out') ?? join(outDir, 'runs.jsonl');
    const label = arg('--label');
    const { records, sources } = collect(dir, label);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, toJsonl(records));

    const validation = validateRecords(records);
    const manifest = {
      label: label ?? basename(dirname(out)),
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      source: 'harness-reports',
      sources,
      executionModes: [...new Set(records.map(r => r.executionMode))],
      records: records.length,
      agents: new Set(records.map(r => r.agentId)).size,
      dataQuality: { usable: validation.ok.length, rejected: validation.rejected.length, issues: validation.issues },
      notes: 'Each harness report is one process; lifecycle timestamps are comparable within a runId only.',
    };
    writeFileSync(join(dirname(out), 'manifest.json'), JSON.stringify(manifest, null, 2));

    process.stderr.write(`${records.length} record(s) written to ${out}\n`);
    process.stderr.write(`${renderValidation(validation)}\n`);
    return;
  }

  if (command === 'bands') {
    const file = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : DEFAULT_RUNS;
    const records = loadRecords(file);
    const width = Number(arg('--width') ?? '64');
    const wanted = arg('--workflow');
    const groupOf = (r: AgentLifecycleRecord): string => r.parentTaskId ?? r.taskId;

    // Default to the workflow with the most agents running models at once —
    // the one that shows what concurrency actually looked like.
    const pick = wanted ?? summarizeWorkflows(records)
      .sort((a, b) => b.maxConcurrentModelRunning - a.maxConcurrentModelRunning || b.modelDemandOverlapFraction - a.modelDemandOverlapFraction)[0]?.parentTaskId;
    const members = records.filter(r => groupOf(r) === pick);
    if (members.length === 0) {
      process.stderr.write(`No records for workflow ${pick}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`Workflow ${pick}  (${members.length} agent run(s))`);
    console.log(renderAgentBands(members, width));
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
  // Malformed traces are reported and excluded rather than silently averaged in.
  const validation = validateRecords(records);
  const analysis = analyzeRecords(validation.ok, input);
  const outDir = arg('--out-dir') ?? dirname(input);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'workflows.jsonl'), analysis.workflows.map(w => JSON.stringify(w)).join('\n') + (analysis.workflows.length > 0 ? '\n' : ''));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
    ...analysis,
    dataQuality: { usable: validation.ok.length, rejected: validation.rejected.length, issues: validation.issues },
  }, null, 2));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    console.log(renderLifecycleReport(analysis));
    console.log('');
    console.log(renderValidation(validation));
    console.log('');
    console.log(`Workflows written to ${join(outDir, 'workflows.jsonl')}`);
    console.log(`Summary written to   ${join(outDir, 'summary.json')}`);
  }
}

main();
