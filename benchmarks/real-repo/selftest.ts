/**
 * Is an instance usable as an experiment task?
 *
 * Two questions, and a task is only usable if both answer correctly:
 *
 *   - at the base commit the check FAILS  (there is a real bug to fix)
 *   - with the upstream fix applied it PASSES  (the check recognizes the fix)
 *
 * The second is the one that matters most. A checker that never passes would
 * make every arm fail identically and the experiment would measure nothing.
 * This calls no model; it is the gate that decides which instances enter the
 * task pool, and it runs before any money is spent.
 *
 *   npx tsx benchmarks/real-repo/selftest.ts [instanceId ...]
 *   npx tsx benchmarks/real-repo/selftest.ts --django-local --out benchmarks/experiments/real-repo-heldout/selftest.json --cleanup
 *
 * `--django-local` takes every Django instance whose SWE-bench image is
 * already present locally (nothing is pulled). Results are written after each
 * instance, and `--resume` skips instances already in the output file, so a
 * long run can be stopped and continued. `--cleanup` removes each selftest
 * container once its instance is checked.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { containerFor, imageFor, inRepo, loadInstances, prepareInstance, type SweItem } from './workload.js';

export interface InstanceCheck {
  instanceId: string;
  repo: string;
  failsAtBase: boolean;
  passesWithGoldPatch: boolean;
  usable: boolean;
  seconds: number;
  note?: string;
}

export function checkInstance(item: SweItem, slot = 'selftest'): InstanceCheck {
  const started = Date.now();
  const base = { instanceId: item.instance_id, repo: item.repo };
  try {
    const prepared = prepareInstance(item, slot);
    const atBase = prepared.verify();

    const applied = inRepo(prepared.container, 'git apply --whitespace=nowarn -', 60_000, item.patch);
    const withFix = applied.status === 0
      ? prepared.verify()
      : { success: false, output: `gold patch did not apply: ${applied.stderr.trim().slice(0, 120)}` };

    // Leave the repository as we found it.
    inRepo(prepared.container, `git checkout -q ${item.base_commit} -- . && git clean -fdq`, 120_000);

    const usable = !atBase.success && withFix.success;
    return {
      ...base,
      failsAtBase: !atBase.success,
      passesWithGoldPatch: withFix.success,
      usable,
      seconds: Math.round((Date.now() - started) / 1000),
      ...(usable ? {} : { note: (!atBase.success ? withFix.output : atBase.output).split('\n')[0].slice(0, 160) }),
    };
  } catch (err) {
    return {
      ...base, failsAtBase: false, passesWithGoldPatch: false, usable: false,
      seconds: Math.round((Date.now() - started) / 1000),
      note: err instanceof Error ? err.message.slice(0, 160) : String(err),
    };
  }
}

/** Images present locally, as `repository:tag`. Nothing is pulled. */
export function localImages(): Set<string> {
  const r = spawnSync('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8', windowsHide: true });
  return new Set((r.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean));
}

/** Django instances whose image is already local, in instance-id order. */
export function localDjangoCandidates(all: readonly SweItem[], images: ReadonlySet<string>): SweItem[] {
  return all
    .filter(i => i.repo === 'django/django' && images.has(imageFor(i.instance_id)))
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id));
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const flagsWithValue = new Set(['--out', '--slot']);
  const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !flagsWithValue.has(all[i - 1] ?? ''));
  const all = loadInstances();
  const items = process.argv.includes('--django-local')
    ? localDjangoCandidates(all, localImages())
    : all.filter(i => positional.includes(i.instance_id));
  if (items.length === 0) {
    process.stderr.write('usage: selftest.ts <instanceId> [...] | --django-local [--out file] [--resume] [--cleanup]\n');
    process.exitCode = 1;
    return;
  }

  const out = resolve(arg('--out') ?? 'benchmarks/experiments/real-repo-validation/selftest.json');
  const slot = arg('--slot') ?? 'selftest';
  const checks: InstanceCheck[] = process.argv.includes('--resume') && existsSync(out)
    ? JSON.parse(readFileSync(out, 'utf8')) as InstanceCheck[]
    : [];
  const done = new Set(checks.map(c => c.instanceId));
  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(`${items.length} candidate(s), ${items.filter(i => done.has(i.instance_id)).length} already checked\n`);

  for (const item of items) {
    if (done.has(item.instance_id)) continue;
    const c = checkInstance(item, slot);
    checks.push(c);
    writeFileSync(out, JSON.stringify(checks, null, 2));
    process.stdout.write(
      `${c.instanceId.padEnd(28)} base=${c.failsAtBase ? 'fails' : 'PASSES'}  gold=${c.passesWithGoldPatch ? 'passes' : 'FAILS'}  `
      + `${c.seconds}s  ${c.usable ? 'usable' : 'UNUSABLE'}${c.note ? ` — ${c.note}` : ''}\n`,
    );
    if (process.argv.includes('--cleanup')) {
      spawnSync('docker', ['rm', '-f', containerFor(item.instance_id, slot)], { windowsHide: true });
    }
  }

  process.stdout.write(`\n${checks.filter(c => c.usable).length}/${checks.length} usable, written to ${out}\n`);
}

// Run only as a script, so the selection helpers can be imported.
if (process.argv[1] && /selftest\.ts$/.test(process.argv[1])) main();
