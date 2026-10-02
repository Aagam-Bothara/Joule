/**
 * Staged-recovery replication CLI.
 *
 *   npx tsx benchmarks/staged-replication/cli.ts selftest
 *   npx tsx benchmarks/staged-replication/cli.ts run --seeds 3
 *   npx tsx benchmarks/staged-replication/cli.ts run --fixtures r-api-contract --seeds 1   # calibration
 *   npx tsx benchmarks/staged-replication/cli.ts analyze
 *
 * A fresh fixture set, the same three arms, and the runtime frozen: this exists
 * to find out whether the staged policy holds on repositories it was not
 * designed against. `selftest` and `analyze` call no model.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl } from '../lifecycle/record.js';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import { manifestBilling } from '../crew-scaling/record.js';
import { renderSelfTest, selfTestAll } from '../specialist-value/selftest.js';
import { runStagedComparison } from '../specialist-value/runner.js';
import { COMPARISON_ARMS, comparisonCrew, type ComparisonArm } from '../specialist-value/crews.js';
import { compareStaged, renderStagedComparison } from '../specialist-value/staged-analyze.js';
import { REPLICATION_FIXTURES } from './fixtures.js';

const DEFAULT_DIR = join('benchmarks', 'experiments', 'staged-replication');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Whether tracked files differ from that commit.
 *
 * The commit alone would misdescribe the runtime if the fixes under test are
 * still uncommitted, so the manifest says which it is.
 */
function workingTreeDirty(): boolean {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' })
      .split('\n')
      .some(line => line.trim().length > 0 && !line.includes('?? '));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'selftest';
  const outDir = arg('--out-dir') ?? DEFAULT_DIR;

  if (command === 'selftest') {
    const checks = selfTestAll(REPLICATION_FIXTURES);
    process.stdout.write(renderSelfTest(checks) + '\n');
    process.exitCode = checks.every(c => c.ok) ? 0 : 1;
    return;
  }

  if (command === 'run') {
    const broken = selfTestAll(REPLICATION_FIXTURES).filter(c => !c.ok);
    if (broken.length > 0) {
      process.stderr.write(`Refusing to run: ${broken.length} fixture(s) failed the self-test\n`);
      process.exitCode = 1;
      return;
    }

    const fixtureIds = arg('--fixtures')?.split(',').map(s => s.trim()).filter(Boolean);
    const seeds = Number(arg('--seeds', '3'));
    const model = arg('--model') ?? 'deepseek/deepseek-v4-flash';
    const provider = arg('--provider') ?? 'openrouter';
    const arms = (arg('--arms') ?? 'primary,full,staged').split(',').map(s => s.trim()).filter(Boolean) as ComparisonArm[];
    const fixtures = fixtureIds
      ? REPLICATION_FIXTURES.filter(f => fixtureIds.includes(f.id))
      : REPLICATION_FIXTURES;
    process.stderr.write(`${fixtures.length * arms.length * seeds} run(s): ${fixtures.length} task(s) x ${arms.length} arm(s) x ${seeds} repetition(s), ${model}\n`);

    const started = new Date().toISOString();
    const byArm = await runStagedComparison({
      fixtures,
      arms,
      seeds,
      provider,
      model,
      outDir,
      label: arg('--label') ?? 'staged-replication',
    });

    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
      startedAt: started,
      finishedAt: new Date().toISOString(),
      runtimeCommit: gitCommit(),
      runtimeDirty: workingTreeDirty(),
      model,
      provider,
      arms,
      taskIds: fixtures.map(f => f.id),
      defectClasses: fixtures.map(f => f.defect.type),
      repetitions: seeds,
      budgetMode: comparisonCrew('staged').budgetMode,
      crewBudget: comparisonCrew('staged').budget,
      verificationPolicy: 'python run_tests.py in the task directory, rewritten from the fixture before every judgement',
      verifiedEditGate: true,
      // The loop rule these runs were made under, since it changes agent capability.
      toolLoopSemantics: 'identical-call repeat blocked (tool + arguments); no tool is ever disabled',
      runs: byArm.reduce((n, a) => n + a.records.length, 0),
      totalCostUsd: byArm.reduce((s, a) => s + a.records.reduce((x, r) => x + (r.totalCostUsd ?? 0), 0), 0),
      costAccounting: 'totalCostUsd is Joule\'s estimate from tokens and the local price table; billing.totalBilledCostUsd is what the provider reported it billed (OpenRouter usage.cost), covering billing.billedModelCalls of billing.modelCalls',
      billing: manifestBilling(byArm.flatMap(a => a.records)),
    }, null, 2));

    const spend = byArm.reduce((s, a) => s + a.records.reduce((x, r) => x + (r.totalCostUsd ?? 0), 0), 0);
    process.stderr.write(`\n${byArm.reduce((n, a) => n + a.records.length, 0)} run(s), $${spend.toFixed(4)} spent, written under ${outDir}\n`);
    return;
  }

  if (command === 'analyze') {
    const arms = (arg('--arms') ?? 'primary,full,staged').split(',').map(s => s.trim()).filter(Boolean);
    const byArm = arms.flatMap(arm => {
      const file = join(outDir, arm, 'runs.jsonl');
      if (!existsSync(file)) return [];
      return [{ arm, records: parseJsonl<CrewScalingRecord>(readFileSync(file, 'utf8')) }];
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

export { COMPARISON_ARMS };
