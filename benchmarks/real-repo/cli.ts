/**
 * Real-repository validation CLI.
 *
 *   npx tsx benchmarks/real-repo/cli.ts pool
 *   npx tsx benchmarks/real-repo/cli.ts run --arms full_verify,staged --tasks 13
 *   npx tsx benchmarks/real-repo/cli.ts analyze
 *
 * The task pool is decided by `benchmarks/real-repo/selftest.ts` before any run
 * and is not revisited afterwards. `pool` and `analyze` call no model.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseJsonl } from '../lifecycle/record.js';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import { runCrewScaling } from '../crew-scaling/runner.js';
import { comparisonCrew, type ComparisonArm } from '../specialist-value/crews.js';
import { sweCrew } from './crews.js';
import { observedRepoTools } from './record.js';
import { compareStaged, renderStagedComparison } from '../specialist-value/staged-analyze.js';
import { repoTools } from '../harness/workloads/swebench.js';
import { manifestBilling } from '../crew-scaling/record.js';
import { ARTIFACT_ROOT, CHECK_LABEL, currentContainer, loadInstances, sweWorkloads, type SweItem } from './workload.js';

const DEFAULT_DIR = join('benchmarks', 'experiments', 'real-repo-validation');
const TOOLS_NOTE = 'repo_read, repo_write, repo_edit, repo_shell (container-side; the authored fixtures used host file/shell tools)';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const gitCommit = (): string => {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
};
const treeDirty = (): boolean => {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' })
      .split('\n').some(l => l.trim().length > 0 && !l.includes('?? '));
  } catch { return false; }
};

/**
 * The instances the self-test admitted, in a fixed order.
 *
 * Selection is the self-test's verdict and nothing else: it ran before any
 * model did, and it never saw a Joule result.
 */
export function taskPool(limit?: number): SweItem[] {
  const file = join(DEFAULT_DIR, 'selftest.json');
  if (!existsSync(file)) throw new Error(`run the self-test first: no ${file}`);
  const checks = JSON.parse(readFileSync(file, 'utf8')) as Array<{ instanceId: string; usable: boolean }>;
  const usable = checks.filter(c => c.usable).map(c => c.instanceId).sort();
  const byId = new Map(loadInstances().map(i => [i.instance_id, i]));
  const items = usable.map(id => byId.get(id)).filter((i): i is SweItem => i !== undefined);
  return limit !== undefined ? items.slice(0, limit) : items;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pool';
  const outDir = arg('--out-dir') ?? DEFAULT_DIR;

  if (command === 'pool') {
    const items = taskPool();
    process.stdout.write(`${items.length} task(s) in the pool\n`);
    for (const i of items) process.stdout.write(`  ${i.instance_id.padEnd(28)} ${i.repo}\n`);
    return;
  }

  if (command === 'run') {
    const arms = (arg('--arms') ?? 'full_verify,staged').split(',').map(s => s.trim()).filter(Boolean) as ComparisonArm[];
    const limit = arg('--tasks') ? Number(arg('--tasks')) : undefined;
    const only = arg('--instances')?.split(',').map(s => s.trim()).filter(Boolean);
    const seeds = Number(arg('--seeds', '1'));
    const model = arg('--model') ?? 'deepseek/deepseek-v4-flash';
    const provider = arg('--provider') ?? 'openrouter';
    let items = taskPool(limit);
    if (only) items = items.filter(i => only.includes(i.instance_id));

    process.stderr.write(`${items.length * arms.length * seeds} run(s): ${items.length} real issue(s) x ${arms.length} arm(s) x ${seeds} rep(s), ${model}\n`);
    const started = new Date().toISOString();
    const results: Array<{ arm: string; records: CrewScalingRecord[] }> = [];

    for (const arm of arms) {
      process.stderr.write(`\n--- arm ${arm} ---\n`);
      const records = await runCrewScaling({
        // A container per (instance, arm): no arm can inherit another's edits.
        workloads: sweWorkloads(items, arm),
        crewFactory: () => sweCrew(arm),
        tools: repoTools(currentContainer, join(ARTIFACT_ROOT, arm, 'shadow')),
        widths: [1],
        tasks: items.length,
        offset: 0,
        seeds,
        verifiedEdit: true,
        provider,
        model,
        outDir: join(outDir, arm),
        label: `real-repo-${arm}`,
      });
      results.push({ arm, records });
    }

    mkdirSync(outDir, { recursive: true });
    const observedTools = observedRepoTools(results.flatMap(r => r.records));
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
      startedAt: started,
      finishedAt: new Date().toISOString(),
      runtimeCommit: gitCommit(),
      runtimeDirty: treeDirty(),
      responseParser: 'array-xml-bare-alias-v1',
      toolOutputPolicy: 'repo_read 16000 chars, repo_shell 10000 chars, other tools 1000 chars',
      containerPythonEditGuard: 'repo_write/repo_edit compile .py and .pyi after writing; restore previous content or remove a new file on failure',
      costAccounting: 'totalCostUsd is Joule\'s budget estimate from total tokens and the local model price table; billing.totalBilledCostUsd is what the provider reported it billed (OpenRouter usage.cost), covering billing.billedModelCalls of billing.modelCalls; billing.modelHosts counts calls per upstream host OpenRouter reported (recorded, not pinned)',
      benchmark: 'SWE-bench Lite (princeton-nlp/SWE-bench_Lite, test split)',
      selectionRule: 'image present locally AND repo is pytest-driven (pytest/pylint/flask) AND self-test passes (fails at base commit, passes with the upstream fix)',
      model, provider, arms,
      taskIds: items.map(i => i.instance_id),
      repositories: [...new Set(items.map(i => i.repo))],
      repetitions: seeds,
      budgetMode: sweCrew('staged').budgetMode,
      perAgentBudget: sweCrew('staged').budget,
      verificationPolicy: 'SWE-bench criterion in-container: hidden test patch applied over the agent\'s work, FAIL_TO_PASS and PASS_TO_PASS must all pass, test files restored to the base commit (files the patch added removed) afterwards, tests run with PYTHONDONTWRITEBYTECODE=1',
      checkerPlacement: 'checker (with the test patch embedded) kept on the host under the artifact directory and piped into the container on stdin for each check (benchmarks/real-repo/run-check.ts); nothing of it is written in the container; /tmp/test.patch and /tmp/check.py left by older runs, and hidden-test bytecode, are removed when an instance is prepared',
      checkFeedback: `agents are told the check by name ("${CHECK_LABEL}"), never its command; its output (F2P/P2P counts, failing test names, a log tail) is shown unchanged: last 400 chars in gate messages, up to 1200 chars in the staged-recovery handoff`,
      verifiedEditGate: 'enabled; snapshots and restores container-side files (repo_write/repo_edit paths under /testbed, read and written via docker exec) and rolls back an edit that turns a passing check into a failing one; a restore that fails is reported to the agent as not restored and counted as restoreFailedWrites, never as a rollback',
      toolArgumentRecording: 'agentResults[].tools[].args: call arguments as JSON, secrets redacted, truncated to 300 chars',
      tools: TOOLS_NOTE,
      observedTools,
      toolLoopSemantics: 'identical-call repeat blocked (tool + arguments); no tool is ever disabled',
      runs: results.reduce((n, r) => n + r.records.length, 0),
      totalCostUsd: results.reduce((s, r) => s + r.records.reduce((x, y) => x + (y.totalCostUsd ?? 0), 0), 0),
      billing: manifestBilling(results.flatMap(r => r.records)),
    }, null, 2));

    const spend = results.reduce((s, r) => s + r.records.reduce((x, y) => x + (y.totalCostUsd ?? 0), 0), 0);
    process.stderr.write(`\n${results.reduce((n, r) => n + r.records.length, 0)} run(s), $${spend.toFixed(4)} estimated, ${observedTools.writeAttempts} observed write attempt(s), ${observedTools.unidentifiedCalls} unidentified call(s), written under ${outDir}\n`);
    return;
  }

  if (command === 'analyze') {
    const arms = (arg('--arms') ?? 'full_verify,staged').split(',').map(s => s.trim()).filter(Boolean);
    const byArm = arms.flatMap(arm => {
      const file = join(outDir, arm, 'runs.jsonl');
      return existsSync(file) ? [{ arm, records: parseJsonl<CrewScalingRecord>(readFileSync(file, 'utf8')) }] : [];
    });
    if (byArm.length === 0) {
      process.stderr.write(`No records under ${outDir}\n`);
      process.exitCode = 1;
      return;
    }
    const comparison = compareStaged(byArm);
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(comparison, null, 2));
    process.stdout.write(renderStagedComparison(comparison) + '\n');
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

export { resolve };
