/**
 * Run a real-repo instance's checker against its container.
 *
 *   node node_modules/tsx/dist/cli.mjs benchmarks/real-repo/run-check.ts <container> <checker.py>
 *
 * This is the command the verified-edit gate and the staged-recovery verifier
 * run (see `verifyCommand` in workload.ts). The checker stays on the host and
 * is piped into the container on stdin, so nothing it contains is ever left
 * where an agent could read it. Prints the checker's output and exits with its
 * status.
 */

import { runCheck } from './workload.js';

const [container, checker] = process.argv.slice(2);
if (!container || !checker) {
  process.stderr.write('usage: run-check.ts <container> <checker.py>\n');
  process.exitCode = 2;
} else {
  const r = runCheck(container, checker);
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.status;
}
