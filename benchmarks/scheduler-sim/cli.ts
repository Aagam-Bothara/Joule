/**
 * Trace-driven scheduling simulation CLI.
 *
 *   npx tsx benchmarks/scheduler-sim/cli.ts --model-capacity 1 --tool-capacity 4
 *   npx tsx benchmarks/scheduler-sim/cli.ts --input <runs.jsonl> --policies observed,oracle
 *   npx tsx benchmarks/scheduler-sim/cli.ts --sweep
 *   npx tsx benchmarks/scheduler-sim/cli.ts --contention          # hypothetical tool slowdown on
 *
 * Offline analysis over existing lifecycle traces. It schedules nothing and
 * changes nothing in Joule.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseJsonl } from '../lifecycle/record.js';
import type { AgentLifecycleRecord } from '../lifecycle/types.js';
import { recordsToAgents } from './trace-to-phases.js';
import { simulate } from './simulator.js';
import { POLICY_ORDER } from './policies.js';
import { compare, renderImprovements, renderPolicyTable, renderSweep } from './metrics.js';
import type { PolicyName, SimMetrics } from './types.js';

const DEFAULT_INPUT = 'benchmarks/experiments/lifecycle/real-crews-repo/runs.jsonl';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function main(): void {
  const input = arg('--input') ?? DEFAULT_INPUT;
  if (!existsSync(input)) {
    process.stderr.write(`No trace dataset at ${input}\n`);
    process.exitCode = 1;
    return;
  }
  const records = parseJsonl<AgentLifecycleRecord>(readFileSync(input, 'utf8'));
  const agents = recordsToAgents(records);
  const contention = process.argv.includes('--contention');
  const staggerMs = Number(arg('--stagger') ?? '500');
  const policies = (arg('--policies')?.split(',') as PolicyName[] | undefined) ?? POLICY_ORDER;

  const phases = agents.reduce((s, a) => s + a.phases.length, 0);
  console.log(`Trace-driven scheduling simulation`);
  console.log(`  input      ${input}`);
  console.log(`  agents     ${agents.length} across ${new Set(agents.map(a => a.workflowId)).size} workflow(s), ${phases} measured phases`);
  console.log(`  contention ${contention ? 'ON (hypothetical slowdown factors)' : 'OFF (measured durations only)'}`);

  const run = (policy: PolicyName, modelCapacity: number, toolCapacity: number): SimMetrics =>
    simulate(agents, { policy, modelCapacity, toolCapacity, staggerMs, contention });

  if (process.argv.includes('--sweep')) {
    const rows = [];
    for (const modelCapacity of [1, 2, 4]) {
      for (const toolCapacity of [1, 2, 4]) {
        const all = policies.map(p => run(p, modelCapacity, toolCapacity));
        const baseline = all.find(r => r.policy === 'observed') ?? all[0];
        const oracle = all.find(r => r.policy === 'oracle') ?? baseline;
        const best = [...all].sort((a, b) => a.makespanMs - b.makespanMs || a.meanJctMs - b.meanJctMs)[0];
        rows.push({ modelCapacity, toolCapacity, baseline, best, oracle });
      }
    }
    console.log('');
    console.log(renderSweep(rows));
    return;
  }

  const modelCapacity = Number(arg('--model-capacity') ?? '1');
  const toolCapacity = Number(arg('--tool-capacity') ?? '4');
  console.log(`  capacity   model ${modelCapacity}, tool ${toolCapacity}`);
  console.log('');

  // Each workflow scheduled on its own resources — the per-crew question,
  // without the queueing that batching every workflow together creates.
  if (process.argv.includes('--per-workflow')) {
    const ids = [...new Set(agents.map(a => a.workflowId))].sort();
    const perPolicy = new Map<PolicyName, { makespans: number[]; meanJcts: number[]; zero: number[]; sync: number[] }>();
    for (const policy of policies) {
      const acc = { makespans: [] as number[], meanJcts: [] as number[], zero: [] as number[], sync: [] as number[] };
      for (const id of ids) {
        const one = simulate(agents.filter(a => a.workflowId === id), { policy, modelCapacity, toolCapacity, staggerMs, contention });
        acc.makespans.push(one.makespanMs);
        acc.meanJcts.push(one.meanJctMs);
        acc.zero.push(one.zeroModelDemandMs);
        acc.sync.push(one.synchronizedToolWaitFraction);
      }
      perPolicy.set(policy, acc);
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const base = perPolicy.get('observed');
    console.log(`Per-workflow scheduling (${ids.length} workflows, each on its own capacity)`);
    console.log(`${'policy'.padEnd(13)}${'meanMakespan'.padStart(14)}${'meanJCT'.padStart(10)}${'zeroModel'.padStart(11)}${'syncTool'.padStart(10)}${'Δmakespan'.padStart(11)}`);
    console.log('-'.repeat(69));
    for (const policy of policies) {
      const a = perPolicy.get(policy);
      if (!a || !base) continue;
      const delta = ((mean(a.makespans) - mean(base.makespans)) / mean(base.makespans)) * 100;
      console.log(
        policy.padEnd(13)
        + `${(mean(a.makespans) / 1000).toFixed(1)}s`.padStart(14)
        + `${(mean(a.meanJcts) / 1000).toFixed(1)}s`.padStart(10)
        + `${(mean(a.zero) / 1000).toFixed(1)}s`.padStart(11)
        + `${(mean(a.sync) * 100).toFixed(1)}%`.padStart(10)
        + `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`.padStart(11),
      );
    }
    return;
  }

  const results = policies.map(p => run(p, modelCapacity, toolCapacity));
  const baseline = results.find(r => r.policy === 'observed') ?? results[0];
  console.log(renderPolicyTable(results));
  console.log('');
  console.log(renderImprovements(baseline, results));

  const out = arg('--json');
  if (out) {
    writeFileSync(out, JSON.stringify({
      input, modelCapacity, toolCapacity, contention,
      results,
      comparisons: results.filter(r => r.policy !== baseline.policy).map(r => compare(baseline, r)),
    }, null, 2));
    console.log(`\nWritten to ${out}`);
  }
}

main();
