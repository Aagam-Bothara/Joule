/**
 * Long-horizon MBPP bundles: K problems become one task ("implement these K
 * functions in one module; every test must pass"). Trajectories run 2K to 5K
 * steps instead of 3 to 6, which is where per-step escalation should separate
 * from request-level cascades. Success is deterministic: all tests of all K
 * problems pass in a fresh Python process; partial credit is reported as a
 * pass fraction to the verifier ("7/12 tests passed").
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { BUDGET_PRESETS } from '@joule/shared';
import type { Workload } from '../types.js';

interface MbppItem {
  task_id: number;
  prompt: string;
  code: string;
  test_imports: string[];
  test_list: string[];
}

const DATA = resolve('benchmarks/data/sanitized-mbpp.json');
const SANDBOX = resolve('benchmarks/.sandbox/mbpp-bundle', process.env.JOULE_BENCH_LABEL ?? 'default');

function testScript(items: MbppItem[]): string {
  const imports = [...new Set(items.flatMap(i => i.test_imports))];
  const tests = items.flatMap(i => i.test_list);
  return [
    'import os, sys, threading',
    '_watchdog = threading.Timer(20, lambda: os._exit(3))',
    '_watchdog.daemon = True',
    '_watchdog.start()',
    ...imports,
    'from solution import *',
    'TESTS = [',
    ...tests.map(t => `    ${JSON.stringify(t)},`),
    ']',
    'passed = 0',
    'for src in TESTS:',
    '    try:',
    '        exec(src)',
    '        passed += 1',
    '    except Exception as e:',
    '        print(f"FAILED: {src}\\n  {type(e).__name__}: {e}")',
    'print(f"{passed}/{len(TESTS)} tests passed")',
    'if passed == len(TESTS):',
    '    print("ALL TESTS PASSED")',
    'else:',
    '    sys.exit(1)',
    '',
  ].join('\n');
}

function runTests(dir: string, items: MbppItem[]): boolean {
  if (!existsSync(join(dir, 'solution.py'))) return false;
  writeFileSync(join(dir, 'run_tests.py'), testScript(items));
  try {
    const out = execFileSync('python', ['run_tests.py'], { cwd: dir, timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return out.includes('ALL TESTS PASSED');
  } catch {
    return false;
  }
}

/** `n` bundles of `k` consecutive problems each, starting at `offset` problems. */
export function loadMbppBundles(n: number, k = 4, offset = 0): Workload[] {
  if (!existsSync(DATA)) {
    throw new Error(`MBPP dataset not found at ${DATA}. See benchmarks/harness/workloads/mbpp.ts for the download command.`);
  }
  const all = (JSON.parse(readFileSync(DATA, 'utf8')) as MbppItem[]).sort((a, b) => a.task_id - b.task_id);
  const bundles: MbppItem[][] = [];
  for (let i = offset; i + k <= all.length && bundles.length < n; i += k) bundles.push(all.slice(i, i + k));

  return bundles.map(items => {
    const id = `bundle-${items[0].task_id}-${items[items.length - 1].task_id}`;
    const dir = join(SANDBOX, id);
    const solution = join(dir, 'solution.py');
    const tests = join(dir, 'run_tests.py');
    const problems = items.map((item, i) => {
      const fnName = item.code.match(/def\s+(\w+)/)?.[1];
      return [`${i + 1}. ${fnName ? `\`${fnName}\`: ` : ''}${item.prompt}`, ...item.test_list.map(t => `   ${t}`)].join('\n');
    });
    return {
      id,
      complexity: 'high',
      description: [
        `Implement ${items.length} Python functions in ONE file, "${solution}" (create it; the directory exists). Work incrementally: add a function, run the tests, fix failures, then move on.`,
        '',
        'Problems and their tests:',
        ...problems,
        '',
        `All tests are already in "${tests}". Run them with the shell command: python "${tests}" (working directory "${dir}"). The output reports how many tests pass ("7/12 tests passed") and prints ALL TESTS PASSED when everything passes. Finish only when all tests pass, and do not modify run_tests.py.`,
      ].join('\n'),
      policy: { maxSteps: 60 },
      // Long-horizon: a 4-function module takes 15-30 turns with a growing history,
      // which exhausts the 'high' preset's 100k tokens. Same escalation and cost
      // ceilings as 'high' otherwise.
      budget: { ...BUDGET_PRESETS.high, maxTokens: 600_000, maxToolCalls: 60, costCeilingUsd: 2.0, maxLatencyMs: 900_000 },
      setup: () => {
        let removed = false;
        for (let attempt = 0; attempt < 4 && !removed; attempt++) {
          try { rmSync(dir, { recursive: true, force: true }); removed = true; } catch {
            const until = Date.now() + 500;
            while (Date.now() < until) { /* short blocking wait */ }
          }
        }
        mkdirSync(dir, { recursive: true });
        if (!removed) { try { rmSync(solution, { force: true }); } catch { /* ignore */ } }
        writeFileSync(tests, testScript(items));
      },
      verify: () => runTests(dir, items),
      answerForJudge: result => {
        try { return readFileSync(solution, 'utf8'); } catch { return result.result ?? ''; }
      },
    };
  });
}
