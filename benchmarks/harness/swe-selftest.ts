/**
 * Sanity check for the SWE-bench workload's evaluation pipeline:
 * the base commit must fail the hidden tests and the gold patch must pass them.
 *
 *   npx tsx benchmarks/harness/swe-selftest.ts sympy__sympy-11870 django__django-13447
 */
import { selfTest } from './workloads/swebench.js';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: swe-selftest.ts <instance_id> [...]');
  process.exit(2);
}
let bad = 0;
for (const id of ids) {
  const started = Date.now();
  try {
    const { base, gold } = selfTest(id);
    const ok = !base.success && gold.success;
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'BAD '} ${id}  base: ${base.detail}  |  gold: ${gold.detail}  [${((Date.now() - started) / 1000).toFixed(0)}s]`);
  } catch (err) {
    bad++;
    console.log(`ERR  ${id}  ${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(bad === 0 ? 0 : 1);
