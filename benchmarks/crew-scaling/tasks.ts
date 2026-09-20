/**
 * Tasks for the crew-scaling experiment.
 *
 * Real coding work with a deterministic evaluator: each task is an MBPP problem
 * (the dataset the harness already uses), the crew must produce `solution.py`,
 * and success is the problem's own asserts passing in a fresh Python process.
 * The test file is rewritten before every check, so a crew cannot pass by
 * editing the tests.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CrewWidth } from './types.js';

const DATA = resolve('benchmarks/data/sanitized-mbpp.json');
const SANDBOX_ROOT = resolve('benchmarks/.sandbox/crew-scaling');

interface MbppItem {
  task_id: number;
  prompt: string;
  code: string;
  test_imports: string[];
  test_list: string[];
}

export interface ScalingTask {
  workloadId: string;
  prompt: string;
  functionName: string;
  testImports: string[];
  tests: string[];
}

/** The asserts call the function directly, so its name comes from the first one. */
function functionNameOf(tests: string[]): string {
  for (const t of tests) {
    const m = t.match(/assert\s+(?:not\s+)?([A-Za-z_]\w*)\s*\(/);
    if (m) return m[1];
  }
  return 'solve';
}

export function loadScalingTasks(n: number, offset = 0): ScalingTask[] {
  if (!existsSync(DATA)) throw new Error(`MBPP dataset not found at ${DATA}`);
  const items = JSON.parse(readFileSync(DATA, 'utf8')) as MbppItem[];
  return items.slice(offset, offset + n).map(item => ({
    workloadId: `mbpp-${item.task_id}`,
    prompt: item.prompt,
    functionName: functionNameOf(item.test_list),
    testImports: item.test_imports,
    tests: item.test_list,
  }));
}

function testScript(task: ScalingTask): string {
  return [
    'import sys',
    'sys.path.insert(0, ".")',
    'from solution import *  # noqa',
    ...task.testImports,
    `TESTS = ${JSON.stringify(task.tests)}`,
    'passed = 0',
    'for t in TESTS:',
    '    try:',
    '        exec(t)',
    '        passed += 1',
    '    except Exception as e:',
    '        print("FAIL:", t, "->", type(e).__name__, e)',
    'print(f"{passed}/{len(TESTS)} tests passed")',
    'if passed == len(TESTS):',
    '    print("ALL TESTS PASSED")',
    'else:',
    '    sys.exit(1)',
    '',
  ].join('\n');
}

export interface PreparedTask {
  dir: string;
  description: string;
  /** Rewrites the tests, runs them, and reports whether they all passed. */
  verify(): { success: boolean; output: string };
}

/**
 * A fresh directory per (task, width) so runs never see each other's files.
 */
export function prepareTask(task: ScalingTask, width: CrewWidth): PreparedTask {
  const dir = join(SANDBOX_ROOT, `w${width}`, task.workloadId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run_tests.py'), testScript(task));

  const posix = dir.replace(/\\/g, '/');
  const description = [
    `Task directory: ${posix}`,
    '',
    task.prompt,
    '',
    `Write the solution to ${posix}/solution.py. It must define a function named ${task.functionName}.`,
    `The tests in ${posix}/run_tests.py must pass; run them with: python run_tests.py (from ${posix}).`,
    'Do not modify run_tests.py.',
  ].join('\n');

  return {
    dir,
    description,
    verify: () => {
      writeFileSync(join(dir, 'run_tests.py'), testScript(task));
      if (!existsSync(join(dir, 'solution.py'))) return { success: false, output: 'solution.py was never created' };
      try {
        const out = execFileSync('python', ['run_tests.py'], { cwd: dir, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        return { success: out.includes('ALL TESTS PASSED'), output: out.trim().slice(-400) };
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
        const text = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` || e.message || 'tests failed';
        return { success: false, output: text.trim().slice(-400) };
      }
    },
  };
}
