/**
 * Joule escalation benchmark harness.
 *
 *   npx tsx benchmarks/harness/index.ts                          # mock runner, mock strategies
 *   npx tsx benchmarks/harness/index.ts --live                   # real providers, 8 live tasks
 *   npx tsx benchmarks/harness/index.ts --live --workload mbpp --n 30 --offset 0
 *   npx tsx benchmarks/harness/index.ts --live --strategies slm-only,llm-only,frugal-cascade,automix,pre-router,joule-adaptive
 *   npx tsx benchmarks/harness/index.ts --tasks needs-consult,needs-handoff --json
 *   npx tsx benchmarks/harness/index.ts --live ... --resume benchmarks/reports/partial-mbpp-<label>.json   # continue a crashed run
 *   npx tsx benchmarks/harness/index.ts --live --workload swebench --n 15 --strategies slm-only,mid-only,joule-ladder
 *   npx tsx benchmarks/harness/index.ts --live --workload mbpp --n 50 --offset 230 --strategies joule-adaptive,joule-no-consult,joule-advice,joule-no-verify,joule-self-conf,joule-no-static
 *
 * Model pair for live runs: JOULE_BENCH_SLM / JOULE_BENCH_LLM as <provider>:<model>
 * (google | anthropic | openai | openrouter | ollama). JOULE_BENCH_LABEL names the
 * sandbox and the report file so pairs can run concurrently.
 *
 * Same engine, same tools, same prompts — only the routing strategy changes.
 * Every task produces a TaskReport; the run produces a HarnessReport with
 * per-strategy summaries and escalation precision / recall computed from the
 * counterfactual slm-only and llm-only runs for every strategy that escalates.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTrajectory } from '@joule/core';
import { runMockBenchmarks } from './runners/mock-runner.js';
import { runLiveBenchmarks } from './runners/live-runner.js';
import { DEFAULT_STRATEGY_ORDER, MOCK_STRATEGIES } from './strategies/index.js';
import { summarizeStrategy } from './evaluators/cost.js';
import { computeEscalationMetrics } from './evaluators/escalation.js';
import { latencyStats } from './evaluators/latency.js';
import type { HarnessReport, StrategyName, TaskReport } from './types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const usd = (x: number) => `$${x.toFixed(4)}`;

export function renderReport(report: HarnessReport): string {
  const out: string[] = [];
  out.push('');
  out.push(`Joule escalation benchmark — ${report.runner} runner — workload ${report.workload} — ${report.tasks.length} task runs${report.models ? ` — SLM ${report.models.slm}, LLM ${report.models.llm}` : ''}`);
  out.push('');
  out.push('| strategy        | tasks | success | avg cost | gate cost | LLM used | avg SLM tok | avg LLM tok | avg latency | consults | handoffs |');
  out.push('|-----------------|------:|--------:|---------:|----------:|---------:|------------:|------------:|------------:|---------:|---------:|');
  for (const s of report.strategies) {
    out.push(`| ${s.strategy.padEnd(15)} | ${String(s.tasks).padStart(5)} | ${pct(s.successRate).padStart(7)} | ${usd(s.avgCost).padStart(8)} | ${usd(s.avgGateCost).padStart(9)} | ${pct(s.llmUsedRate).padStart(8)} | ${s.avgSlmTokens.toFixed(0).padStart(11)} | ${s.avgLlmTokens.toFixed(0).padStart(11)} | ${`${s.avgLatencyMs.toFixed(0)}ms`.padStart(11)} | ${String(s.consultations).padStart(8)} | ${String(s.handoffs).padStart(8)} |`);
  }

  if (report.escalation.length > 0) {
    out.push('');
    out.push(`Routing quality (ground truth from counterfactuals: slm-only ${pct(report.baselines.slmOnlySuccess)} over ${report.baselines.slmOnlyRepeats} run(s)/task, llm-only ${pct(report.baselines.llmOnlySuccess)}):`);
    out.push('| strategy        | success | cost / llm-only | escalated | needed | precision | soft prec. | wasted | recall | consult ok | handoff ok |');
    out.push('|-----------------|--------:|----------------:|----------:|-------:|----------:|-----------:|-------:|-------:|-----------:|-----------:|');
    for (const e of report.escalation) {
      out.push(`| ${e.strategy.padEnd(15)} | ${pct(e.successRate).padStart(7)} | ${(e.costRatioVsLlmOnly === null ? 'n/a' : e.costRatioVsLlmOnly.toFixed(2)).padStart(15)} | ${String(e.escalated).padStart(9)} | ${String(e.needed).padStart(6)} | ${pct(e.precision).padStart(9)} | ${pct(e.softPrecision).padStart(10)} | ${String(e.wasted).padStart(6)} | ${pct(e.recall).padStart(6)} | ${pct(e.consultSuccessRate).padStart(10)} | ${pct(e.handoffSuccessRate).padStart(10)} |`);
    }
  }

  const lat = latencyStats(report.tasks);
  out.push('');
  out.push(`Latency: avg ${lat.avgMs.toFixed(0)}ms  p50 ${lat.p50Ms.toFixed(0)}ms  p95 ${lat.p95Ms.toFixed(0)}ms  max ${lat.maxMs.toFixed(0)}ms`);

  const demo = report.tasks.find(t => t.strategy === 'joule-adaptive' && t.trajectory && (t.consultations > 0 || t.handoffs > 0))
    ?? report.tasks.find(t => t.strategy === 'joule-adaptive' && t.trajectory);
  if (demo?.trajectory) {
    out.push('');
    out.push(`Example trajectory (${demo.workloadId}):`);
    out.push(renderTrajectory(demo.trajectory));
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const json = process.argv.includes('--json');
  const workload = (arg('--workload') as 'live' | 'mbpp' | 'humaneval' | 'mbpp-bundle' | 'swebench' | undefined) ?? (live ? 'live' : 'mock');
  const n = arg('--n') ? Number(arg('--n')) : undefined;
  const bundle = arg('--bundle') ? Number(arg('--bundle')) : undefined;
  const offset = arg('--offset') ? Number(arg('--offset')) : undefined;
  const repeats = arg('--repeats') ? Number(arg('--repeats')) : undefined;
  const resumeFile = arg('--resume');
  const strategies = (arg('--strategies')?.split(',') as StrategyName[] | undefined) ?? (live ? DEFAULT_STRATEGY_ORDER : MOCK_STRATEGIES);
  const tasks = arg('--tasks')?.split(',');
  const label = process.env.JOULE_BENCH_LABEL ?? 'default';

  if (!json) process.stderr.write(`Running ${live ? 'live' : 'mock'} benchmarks on ${workload}: ${strategies.join(', ')}\n`);
  const dir = join(process.cwd(), 'benchmarks', 'reports');
  mkdirSync(dir, { recursive: true });
  const checkpointFile = join(dir, `partial-${workload}-${label}.json`);
  const resume: TaskReport[] = resumeFile && existsSync(resumeFile)
    ? ((JSON.parse(readFileSync(resumeFile, 'utf8')) as { tasks?: TaskReport[] }).tasks ?? [])
    : [];

  let reports: TaskReport[];
  let models: HarnessReport['models'];
  if (live) {
    const r = await runLiveBenchmarks(strategies, tasks, {
      workload: workload === 'mbpp' ? 'mbpp' : workload === 'humaneval' ? 'humaneval' : workload === 'mbpp-bundle' ? 'mbpp-bundle' : workload === 'swebench' ? 'swebench' : 'live', n, offset, repeats, resume, bundle,
      onCheckpoint: rs => writeFileSync(checkpointFile, JSON.stringify({ partial: true, workload, label, tasks: rs }, null, 2)),
    });
    reports = r.reports;
    models = r.models;
  } else {
    reports = await runMockBenchmarks(strategies, tasks);
  }

  const success = (s: StrategyName) => {
    const rs = reports.filter(r => r.strategy === s);
    return rs.length ? rs.filter(r => r.success).length / rs.length : null;
  };

  const report: HarnessReport = {
    timestamp: new Date().toISOString(),
    runner: live ? 'live' : 'mock',
    workload,
    models,
    strategies: strategies.filter(s => reports.some(r => r.strategy === s)).map(s => summarizeStrategy(s, reports)),
    escalation: computeEscalationMetrics(reports),
    baselines: { slmOnlySuccess: success('slm-only'), llmOnlySuccess: success('llm-only'), slmOnlyRepeats: repeats ?? 1 },
    tasks: reports,
  };

  const file = join(dir, `harness-${report.runner}-${workload}-${label}-${report.timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
    console.log('');
    console.log(`Report written to ${file}`);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
