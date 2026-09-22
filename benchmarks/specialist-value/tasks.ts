/**
 * Materializing a fixture into a sandbox repository the crew can work in.
 *
 * The task a crew is given says only that the suite fails: not which file, not
 * which function, not which kind of mistake. Locating it is the work, and it is
 * the part a reviewer or tester could in principle do better than a lone
 * implementer.
 *
 * The test file is rewritten from the fixture before every check, so a crew
 * cannot pass by editing the tests — the same rule Dataset E used.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Fixture } from './fixtures.js';

export const SANDBOX_ROOT = resolve('benchmarks/.sandbox/specialist-value');

/** Crew arms. Each is the one below it plus one specialist. */
export type Arm = 'A' | 'B' | 'C';

export const ARMS: Arm[] = ['A', 'B', 'C'];

/**
 * Arms are crew-scaling widths 1, 2 and 3 — implementer, plus reviewer, plus
 * tester. The researcher (width 4) is left out on purpose: Dataset E showed it
 * is advisory by construction, and it would blur the question.
 */
export const ARM_WIDTH: Record<Arm, 1 | 2 | 3> = { A: 1, B: 2, C: 3 };

export function armOfWidth(width: number): Arm | undefined {
  return ARMS.find(a => ARM_WIDTH[a] === width);
}

export interface PreparedFixture {
  fixture: Fixture;
  dir: string;
  description: string;
  /** Rewrites the tests, runs them, and reports whether they all passed. */
  verify(): { success: boolean; output: string };
}

export function testScript(fixture: Fixture): string {
  return [
    'import sys',
    'sys.path.insert(0, ".")',
    ...fixture.testImports,
    ...(fixture.testPrelude ?? []),
    `TESTS = ${JSON.stringify(fixture.tests)}`,
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

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function runTests(dir: string): { success: boolean; output: string } {
  try {
    const out = execFileSync('python', ['run_tests.py'], { cwd: dir, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { success: out.includes('ALL TESTS PASSED'), output: out.trim().slice(-600) };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const text = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` || e.message || 'tests failed';
    return { success: false, output: text.trim().slice(-600) };
  }
}

/**
 * A fresh repository per (fixture, slot, repetition), so runs never share state.
 *
 * `slot` separates one arm's workspaces from another's. The directory is also
 * removed and rebuilt on every call, so a run cannot inherit an earlier run's
 * edits even when two arms share a slot.
 */
export function prepareFixture(fixture: Fixture, slot: Arm | string = 'A', seed = 0): PreparedFixture {
  const dir = join(SANDBOX_ROOT, slot, `s${seed}`, fixture.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFiles(dir, fixture.files);
  writeFileSync(join(dir, 'run_tests.py'), testScript(fixture));

  const posix = dir.replace(/\\/g, '/');
  // Every file is listed, so the listing says nothing about which one is
  // wrong — the same thing `dir` would return, without spending three turns
  // to get it. What stays unsaid is where the defect is: naming the file would
  // hand the diagnosis to the implementer and leave the specialists nothing to
  // contribute.
  const listing = [...Object.keys(fixture.files), 'run_tests.py'].sort();
  const description = [
    `Repository: ${posix}`,
    '',
    'Files:',
    ...listing.map(f => `  ${f}`),
    '',
    'This repository has a test suite that fails. Something in the source code is wrong.',
    'Find the cause and fix it, so that every test passes.',
    '',
    `Run the tests with: python run_tests.py (from ${posix})`,
    'Do not modify run_tests.py, and do not change what the tests assert.',
  ].join('\n');

  return {
    fixture,
    dir,
    description,
    verify: () => {
      // Restore the tests before judging, so an edited suite cannot pass.
      writeFileSync(join(dir, 'run_tests.py'), testScript(fixture));
      if (!existsSync(join(dir, 'pkg'))) return { success: false, output: 'the package directory is gone' };
      return runTests(dir);
    },
  };
}

/** Apply the fixture's reference fix in place. Self-test only — never shown to an agent. */
export function applyReferenceFix(prepared: PreparedFixture): void {
  writeFiles(prepared.dir, prepared.fixture.referenceFix);
}
