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
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inRepo, loadInstances, prepareInstance, type SweItem } from './workload.js';

export interface InstanceCheck {
  instanceId: string;
  repo: string;
  failsAtBase: boolean;
  passesWithGoldPatch: boolean;
  usable: boolean;
  seconds: number;
  note?: string;
}

export function checkInstance(item: SweItem): InstanceCheck {
  const started = Date.now();
  const base = { instanceId: item.instance_id, repo: item.repo };
  try {
    const prepared = prepareInstance(item, 'selftest');
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

function main(): void {
  const ids = process.argv.slice(2);
  const all = loadInstances();
  const items = ids.length > 0 ? all.filter(i => ids.includes(i.instance_id)) : [];
  if (items.length === 0) {
    process.stderr.write('usage: selftest.ts <instanceId> [...]\n');
    process.exitCode = 1;
    return;
  }

  const checks = items.map(item => {
    const c = checkInstance(item);
    process.stdout.write(
      `${c.instanceId.padEnd(28)} base=${c.failsAtBase ? 'fails' : 'PASSES'}  gold=${c.passesWithGoldPatch ? 'passes' : 'FAILS'}  `
      + `${c.seconds}s  ${c.usable ? 'usable' : 'UNUSABLE'}${c.note ? ` — ${c.note}` : ''}\n`,
    );
    return c;
  });

  const dir = resolve('benchmarks/experiments/real-repo-validation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'selftest.json'), JSON.stringify(checks, null, 2));
  process.stdout.write(`\n${checks.filter(c => c.usable).length}/${checks.length} usable\n`);
}

main();
