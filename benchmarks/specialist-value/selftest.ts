/**
 * Are the fixtures well-formed?
 *
 * A task that cannot fail, or cannot be fixed, measures nothing. Before any
 * paid run, each fixture is checked on three properties:
 *
 *   - as planted, the suite fails (there is a defect to find)
 *   - as planted, at least one test passes (the suite points somewhere, rather
 *     than being uniformly broken)
 *   - with the reference fix applied, every test passes (the task is solvable,
 *     and the tests do not demand anything else)
 *
 * This runs Python locally and calls no model.
 */

import { applyReferenceFix, prepareFixture, type Arm } from './tasks.js';
import { FIXTURES, type DefectType, type Fixture } from './fixtures.js';

export interface FixtureCheck {
  id: string;
  defectType: DefectType;
  /** The planted repository fails its own suite */
  failsAsPlanted: boolean;
  testsPassingWithDefect: number;
  totalTests: number;
  /** The reference fix makes the whole suite pass */
  passesWithReferenceFix: boolean;
  /** Every file the reference fix rewrites is declared on the defect */
  fixMatchesDeclaredFiles: boolean;
  ok: boolean;
  notes: string[];
}

/** "2/3 tests passed" -> 2 */
function passingCount(output: string): number {
  const match = output.match(/(\d+)\/(\d+) tests passed/);
  return match ? Number(match[1]) : 0;
}

export function selfTestFixture(fixture: Fixture, arm: Arm = 'A', seed = 0): FixtureCheck {
  const notes: string[] = [];
  const prepared = prepareFixture(fixture, arm, seed);

  const planted = prepared.verify();
  const passingWithDefect = passingCount(planted.output);
  if (planted.success) notes.push('the planted repository already passes: there is nothing to diagnose');
  if (passingWithDefect === 0) notes.push('no test passes with the defect in place: the suite cannot localize anything');

  applyReferenceFix(prepared);
  const fixed = prepared.verify();
  if (!fixed.success) notes.push(`the reference fix does not pass: ${fixed.output.split('\n').slice(-2).join(' ')}`);

  const declared = new Set(fixture.defect.files);
  const fixMatchesDeclaredFiles = Object.keys(fixture.referenceFix).every(f => declared.has(f));
  if (!fixMatchesDeclaredFiles) notes.push('the reference fix touches files the defect does not declare');

  const ok = !planted.success && passingWithDefect > 0 && fixed.success && fixMatchesDeclaredFiles;
  return {
    id: fixture.id,
    defectType: fixture.defect.type,
    failsAsPlanted: !planted.success,
    testsPassingWithDefect: passingWithDefect,
    totalTests: fixture.tests.length,
    passesWithReferenceFix: fixed.success,
    fixMatchesDeclaredFiles,
    ok,
    notes,
  };
}

export function selfTestAll(fixtures: readonly Fixture[] = FIXTURES): FixtureCheck[] {
  return fixtures.map(f => selfTestFixture(f));
}

export function renderSelfTest(checks: readonly FixtureCheck[]): string {
  const lines = ['Dataset F fixture self-test', ''];
  lines.push(
    'fixture'.padEnd(24) + 'defect'.padEnd(22) + 'planted'.padEnd(10) + 'signal'.padEnd(9) + 'fixable'.padEnd(9) + 'ok',
  );
  lines.push('-'.repeat(76));
  for (const c of checks) {
    lines.push(
      c.id.padEnd(24)
      + c.defectType.padEnd(22)
      + (c.failsAsPlanted ? 'fails' : 'PASSES').padEnd(10)
      + `${c.testsPassingWithDefect}/${c.totalTests}`.padEnd(9)
      + (c.passesWithReferenceFix ? 'yes' : 'NO').padEnd(9)
      + (c.ok ? 'ok' : 'PROBLEM'),
    );
    for (const note of c.notes) lines.push(`    ${note}`);
  }
  const bad = checks.filter(c => !c.ok).length;
  lines.push('', bad === 0 ? `${checks.length} fixture(s) usable` : `${bad} of ${checks.length} fixture(s) unusable`);
  return lines.join('\n');
}
