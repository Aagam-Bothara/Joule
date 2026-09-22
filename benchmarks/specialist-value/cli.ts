/**
 * Dataset F CLI.
 *
 *   npx tsx benchmarks/specialist-value/cli.ts selftest
 *   npx tsx benchmarks/specialist-value/cli.ts show f-api-contract
 *   npx tsx benchmarks/specialist-value/cli.ts run --arms A,B,C --seeds 3
 *   npx tsx benchmarks/specialist-value/cli.ts analyze
 *   npx tsx benchmarks/specialist-value/cli.ts staged-run --seeds 3
 *   npx tsx benchmarks/specialist-value/cli.ts staged-analyze
 *
 * `selftest` and `show` call no model. `run` does: it needs OPENROUTER_API_KEY
 * in the environment and it spends money, so it prints what it is about to do
 * and honours --fixtures for a cheap calibration pass first.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl } from '../lifecycle/record.js';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import { FIXTURES, fixtureById } from './fixtures.js';
import { prepareFixture, type Arm } from './tasks.js';
import { renderSelfTest, selfTestAll } from './selftest.js';
import { runSpecialistValue, runStagedComparison } from './runner.js';
import type { ComparisonArm } from './crews.js';
import { compareStaged, renderStagedComparison } from './staged-analyze.js';
import { analyzeSpecialistValue, renderSpecialistValueReport } from './analyze.js';

const DEFAULT_DIR = join('benchmarks', 'experiments', 'specialist-value');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'selftest';
  const outDir = arg('--out-dir') ?? DEFAULT_DIR;

  if (command === 'run') {
    // A calibration pass is one fixture across the arms; the full set is the
    // default. Either way the fixtures are checked first, because a malformed
    // task would spend money and measure nothing.
    const broken = selfTestAll().filter(c => !c.ok);
    if (broken.length > 0) {
      process.stderr.write(`Refusing to run: ${broken.length} fixture(s) failed the self-test\n`);
      process.exitCode = 1;
      return;
    }

    const fixtureIds = arg('--fixtures')?.split(',').map(s => s.trim()).filter(Boolean);
    // The control replaces arm B's reviewer with a second implementer.
    const control = process.argv.includes('--control');
    const arms = control
      ? ['B' as Arm]
      : (arg('--arms') ?? 'A,B,C').split(',').map(s => s.trim()).filter(Boolean) as Arm[];
    const seeds = Number(arg('--seeds', '3'));
    const label = arg('--label') ?? 'specialist-value';
    const model = arg('--model') ?? 'deepseek/deepseek-v4-flash';
    const count = (fixtureIds?.length ?? FIXTURES.length) * arms.length * seeds;
    process.stderr.write(`${count} run(s): ${fixtureIds?.length ?? FIXTURES.length} fixture(s) x ${arms.length} arm(s) x ${seeds} repetition(s), model ${model}\n`);

    const records = await runSpecialistValue({
      ...(fixtureIds ? { fixtureIds } : {}),
      arms,
      control,
      seeds,
      provider: arg('--provider') ?? 'openrouter',
      model,
      outDir,
      label,
    });
    const spend = records.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    process.stderr.write(`\n${records.length} run(s), $${spend.toFixed(4)} spent, written to ${join(outDir, 'runs.jsonl')}\n`);
    return;
  }

  if (command === 'staged-run') {
    const broken = selfTestAll().filter(c => !c.ok);
    if (broken.length > 0) {
      process.stderr.write(`Refusing to run: ${broken.length} fixture(s) failed the self-test\n`);
      process.exitCode = 1;
      return;
    }
    const fixtureIds = arg('--fixtures')?.split(',').map(s => s.trim()).filter(Boolean);
    const seeds = Number(arg('--seeds', '3'));
    const model = arg('--model') ?? 'deepseek/deepseek-v4-flash';
    const arms = (arg('--arms') ?? 'primary,full,staged').split(',').map(s => s.trim()).filter(Boolean) as ComparisonArm[];
    const fixtureCount = fixtureIds?.length ?? FIXTURES.length;
    process.stderr.write(`${fixtureCount * arms.length * seeds} run(s): ${fixtureCount} fixture(s) x ${arms.length} arm(s) x ${seeds} repetition(s), model ${model}\n`);

    const byArm = await runStagedComparison({
      ...(fixtureIds ? { fixtureIds } : {}),
      arms,
      seeds,
      provider: arg('--provider') ?? 'openrouter',
      model,
      outDir,
      label: arg('--label') ?? 'staged',
    });
    const spend = byArm.reduce((s, a) => s + a.records.reduce((x, r) => x + (r.totalCostUsd ?? 0), 0), 0);
    process.stderr.write(`\n${byArm.reduce((n, a) => n + a.records.length, 0)} run(s), $${spend.toFixed(4)} spent, written under ${outDir}\n`);
    return;
  }

  if (command === 'staged-analyze') {
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
    writeFileSync(join(outDir, 'staged-summary.json'), JSON.stringify(comparison, null, 2));
    process.stdout.write(renderStagedComparison(comparison) + '\n');
    return;
  }

  if (command === 'analyze') {
    const file = arg('--file') ?? join(outDir, 'runs.jsonl');
    if (!existsSync(file)) {
      process.stderr.write(`No records at ${file}\n`);
      process.exitCode = 1;
      return;
    }
    const records = parseJsonl<CrewScalingRecord>(readFileSync(file, 'utf8'));
    const analysis = analyzeSpecialistValue(records, file);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(analysis, null, 2));
    process.stdout.write(renderSpecialistValueReport(analysis) + '\n');
    return;
  }

  if (command === 'selftest') {
    const checks = selfTestAll();
    process.stdout.write(renderSelfTest(checks) + '\n');
    process.exitCode = checks.every(c => c.ok) ? 0 : 1;
    return;
  }

  if (command === 'show') {
    const id = process.argv[3];
    const fixture = id ? fixtureById(id) : undefined;
    if (!fixture) {
      process.stderr.write(`Unknown fixture. Available: ${FIXTURES.map(f => f.id).join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const prepared = prepareFixture(fixture, 'A', 0);
    const out = [
      `Fixture: ${fixture.id}  (${fixture.defect.type})`,
      '',
      'Planted defect (never shown to an agent):',
      `  ${fixture.defect.summary}`,
      `  fix belongs in: ${fixture.defect.files.join(', ')}`,
      '',
      'Files:',
      ...Object.keys(fixture.files).map(f => `  ${f}`),
      '',
      'Task text the crew receives:',
      ...prepared.description.split('\n').map(l => `  ${l}`),
      '',
    ].join('\n');
    process.stdout.write(out);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
