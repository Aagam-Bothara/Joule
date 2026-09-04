/**
 * HumanEval workload (Chen et al., 2021): 164 Python problems given as a
 * function signature plus docstring, checked by a hidden `check(candidate)`
 * test function. The agent sees the signature and docstring, writes the
 * solution file, and may run the tests; the harness re-runs them in a fresh
 * process to decide success.
 *
 * Dataset: benchmarks/data/HumanEval.jsonl
 *   curl -sL -o benchmarks/data/HumanEval.jsonl.gz \
 *     https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz
 *   gzip -d benchmarks/data/HumanEval.jsonl.gz
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Workload } from '../types.js';

interface HumanEvalItem {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  test: string;
}

const DATA = resolve('benchmarks/data/HumanEval.jsonl');
const SANDBOX = resolve('benchmarks/.sandbox/humaneval', process.env.JOULE_BENCH_LABEL ?? 'default');

function testScript(item: HumanEvalItem): string {
  return [
    'import os, sys, threading',
    '_watchdog = threading.Timer(15, lambda: os._exit(3))',
    '_watchdog.daemon = True',
    '_watchdog.start()',
    'from solution import *',
    item.test,
    'try:',
    `    check(${item.entry_point})`,
    '    print("ALL TESTS PASSED")',
    'except Exception as e:',
    '    print(f"FAILED: {type(e).__name__}: {e}")',
    '    sys.exit(1)',
    '',
  ].join('\n');
}

function runTests(dir: string, item: HumanEvalItem): boolean {
  if (!existsSync(join(dir, 'solution.py'))) return false;
  writeFileSync(join(dir, 'run_tests.py'), testScript(item));
  try {
    const out = execFileSync('python', ['run_tests.py'], { cwd: dir, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return out.includes('ALL TESTS PASSED');
  } catch {
    return false;
  }
}

export function loadHumanEval(n: number, offset = 0): Workload[] {
  if (!existsSync(DATA)) {
    throw new Error(`HumanEval dataset not found at ${DATA}. See benchmarks/harness/workloads/humaneval.ts for the download command.`);
  }
  const items = readFileSync(DATA, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as HumanEvalItem)
    .slice(offset, offset + n);

  return items.map(item => {
    const idx = item.task_id.replace('HumanEval/', '');
    const dir = join(SANDBOX, idx);
    const solution = join(dir, 'solution.py');
    const tests = join(dir, 'run_tests.py');
    return {
      id: `humaneval-${idx}`,
      complexity: 'medium',
      description: [
        `Implement the Python function below (keep the signature and any imports) and save the complete file to "${solution}" (create it; the directory exists).`,
        '',
        '```python',
        item.prompt.trimEnd(),
        '```',
        '',
        `Hidden tests are in "${tests}". Run them with the shell command: python "${tests}" (working directory "${dir}"). They print ALL TESTS PASSED on success. Make them pass before you finish, and do not modify run_tests.py.`,
      ].join('\n'),
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
        writeFileSync(tests, testScript(item));
      },
      verify: () => runTests(dir, item),
      answerForJudge: result => {
        try { return readFileSync(solution, 'utf8'); } catch { return result.result ?? ''; }
      },
    };
  });
}
