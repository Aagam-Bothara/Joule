/**
 * MBPP workload — sanitized MBPP (Austin et al., 2021), 427 Python problems
 * with assert-based tests. Success is deterministic: the harness runs the
 * problem's tests against the solution file in a fresh Python process. The
 * agent sees the tests and can run them itself, which is exactly the setting
 * the escalation policy is designed for (verifier available, SLM first).
 *
 * Dataset: benchmarks/data/sanitized-mbpp.json
 *   curl -sL -o benchmarks/data/sanitized-mbpp.json \
 *     https://raw.githubusercontent.com/google-research/google-research/master/mbpp/sanitized-mbpp.json
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Workload } from '../types.js';

interface MbppItem {
  task_id: number;
  prompt: string;
  code: string;
  test_imports: string[];
  test_list: string[];
}

const DATA = resolve('benchmarks/data/sanitized-mbpp.json');
const SANDBOX = resolve('benchmarks/.sandbox/mbpp', process.env.JOULE_BENCH_LABEL ?? 'default');

/**
 * Runs every assert independently and reports "X/Y tests passed", so a partial
 * fix is visible as progress to the agent and to the verifier. Exit code 1
 * unless all pass. "ALL TESTS PASSED" is the harness's success marker.
 */
function testScript(item: MbppItem): string {
  return [
    'import os, sys, threading',
    // Watchdog: a solution with an infinite loop must not outlive the harness
    // (on Windows the shell timeout does not reliably kill the grandchild).
    '_watchdog = threading.Timer(15, lambda: os._exit(3))',
    '_watchdog.daemon = True',
    '_watchdog.start()',
    ...item.test_imports,
    'from solution import *',
    'TESTS = [',
    ...item.test_list.map(t => `    ${JSON.stringify(t)},`),
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

function runTests(dir: string, item: MbppItem): boolean {
  if (!existsSync(join(dir, 'solution.py'))) return false;
  // Restore the test file in case the agent edited it.
  writeFileSync(join(dir, 'run_tests.py'), testScript(item));
  try {
    const out = execFileSync('python', ['run_tests.py'], { cwd: dir, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return out.includes('ALL TESTS PASSED');
  } catch {
    return false;
  }
}

export function loadMbpp(n: number, offset = 0): Workload[] {
  if (!existsSync(DATA)) {
    throw new Error(`MBPP dataset not found at ${DATA}. See benchmarks/harness/workloads/mbpp.ts for the download command.`);
  }
  const items = (JSON.parse(readFileSync(DATA, 'utf8')) as MbppItem[])
    .sort((a, b) => a.task_id - b.task_id)
    .slice(offset, offset + n);

  return items.map(item => {
    const dir = join(SANDBOX, String(item.task_id));
    const solution = join(dir, 'solution.py');
    const tests = join(dir, 'run_tests.py');
    const fnName = item.code.match(/def\s+(\w+)/)?.[1];
    return {
      id: `mbpp-${item.task_id}`,
      complexity: 'medium',
      description: [
        `Write a Python function${fnName ? ` named \`${fnName}\`` : ''} that solves the problem below and save it to the file "${solution}" (create it; the directory exists).`,
        '',
        `Problem: ${item.prompt}`,
        '',
        'It must pass these tests:',
        ...item.test_list,
        '',
        `The tests are already in "${tests}". Run them with the shell command: python "${tests}" (working directory "${dir}"). They print ALL TESTS PASSED on success. Make them pass before you finish, and do not modify run_tests.py.`,
      ].join('\n'),
      setup: () => {
        // A previous attempt's Python process can still hold the directory on
        // Windows (EBUSY). Retry briefly, then fall back to resetting the files
        // in place — what matters is that no stale solution.py survives.
        let removed = false;
        for (let attempt = 0; attempt < 4 && !removed; attempt++) {
          try {
            rmSync(dir, { recursive: true, force: true });
            removed = true;
          } catch {
            const until = Date.now() + 500;
            while (Date.now() < until) { /* short blocking wait */ }
          }
        }
        mkdirSync(dir, { recursive: true });
        if (!removed) {
          try { rmSync(solution, { force: true }); } catch { /* leave it; verify() will see whatever is there */ }
        }
        writeFileSync(tests, testScript(item));
      },
      verify: () => runTests(dir, item),
      answerForJudge: result => {
        try { return readFileSync(solution, 'utf8'); } catch { return result.result ?? ''; }
      },
    };
  });
}
