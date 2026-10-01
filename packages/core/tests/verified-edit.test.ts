import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerifiedEditGate, type CheckResult } from '../src/verified-edit.js';

/**
 * The check command is injected, so these tests never spawn a shell: what is
 * under test is the decision to keep or undo a write, not the checker.
 */
function gateWith(results: boolean[], tools?: string[]) {
  const calls: number[] = [];
  let i = 0;
  const run = async (): Promise<CheckResult> => {
    const passed = results[Math.min(i, results.length - 1)];
    calls.push(i);
    i++;
    return { passed, output: passed ? 'ALL TESTS PASSED' : 'FAIL: assertion error' };
  };
  const gate = new VerifiedEditGate({ command: 'noop', ...(tools ? { tools } : {}) }, undefined, undefined, run);
  return { gate, checkCount: () => calls.length };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joule-verified-edit-'));
  file = join(dir, 'solution.py');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('VerifiedEditGate', () => {
  it('guards only write tools that name a file', () => {
    const { gate } = gateWith([true]);
    expect(gate.guards('file_write', { path: file, content: 'x' })).toBe(true);
    expect(gate.guards('repo_edit', { path: file })).toBe(true);
    expect(gate.guards('shell_exec', { command: 'python run_tests.py' })).toBe(false);
    expect(gate.guards('file_read', { path: file })).toBe(false);
    expect(gate.guards('file_write', { content: 'no path here' })).toBe(false);
  });

  it('honours a custom tool list', () => {
    const { gate } = gateWith([true], ['repo_write']);
    expect(gate.guards('repo_write', { path: file })).toBe(true);
    expect(gate.guards('file_write', { path: file })).toBe(false);
  });

  it('keeps an edit that leaves the workspace passing', async () => {
    writeFileSync(file, 'def f():\n    return 1\n');
    const { gate } = gateWith([true, true]);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: file });
    writeFileSync(file, 'def f():\n    return 2\n');
    const decision = await gate.review(before, 'file_write');

    expect(decision).toMatchObject({ kept: true, rolledBack: false });
    expect(readFileSync(file, 'utf8')).toContain('return 2');
    expect(gate.stats).toMatchObject({ rollbacks: 0, verified: true });
  });

  it('rolls back an edit that turns a passing state into a failing one', async () => {
    writeFileSync(file, 'def f():\n    return 1\n');
    const { gate } = gateWith([true, false]);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: file });
    writeFileSync(file, 'def f():\n    return BROKEN\n');
    const decision = await gate.review(before, 'file_write');

    expect(decision.kept).toBe(false);
    expect(decision.rolledBack).toBe(true);
    expect(decision.message).toContain('rolled back');
    // The working version is back.
    expect(readFileSync(file, 'utf8')).toContain('return 1');
    expect(gate.stats.rollbacks).toBe(1);
  });

  it('lets a failing workspace stay broken while nothing has passed yet', async () => {
    writeFileSync(file, 'def f():\n    return BROKEN\n');
    const { gate } = gateWith([false, false]);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: file });
    writeFileSync(file, 'def f():\n    return STILL_BROKEN\n');
    const decision = await gate.review(before, 'file_write');

    // No verified state to protect: the agent is still working towards one.
    expect(decision).toMatchObject({ kept: true, rolledBack: false });
    expect(decision.message).toContain('Verification did not pass');
    expect(readFileSync(file, 'utf8')).toContain('STILL_BROKEN');
    expect(gate.stats.rollbacks).toBe(0);
  });

  it('protects a state that only became passing mid-run', async () => {
    writeFileSync(file, 'broken');
    const { gate } = gateWith([false, true, false]);
    await gate.establishBaseline();          // fails: nothing to protect

    const firstFix = gate.snapshot({ path: file });
    writeFileSync(file, 'good');
    expect((await gate.review(firstFix, 'file_write')).kept).toBe(true);   // now passing

    const regression = gate.snapshot({ path: file });
    writeFileSync(file, 'broken again');
    const decision = await gate.review(regression, 'file_write');

    expect(decision.rolledBack).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('good');
  });

  it('removes a file that did not exist before the rejected write', async () => {
    const { gate } = gateWith([true, false]);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: file });
    writeFileSync(file, 'brand new but broken');
    const decision = await gate.review(before, 'file_write');

    expect(decision.rolledBack).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('restores every file a multi-file write touched', async () => {
    const other = join(dir, 'helper.py');
    writeFileSync(file, 'good main');
    writeFileSync(other, 'good helper');
    const { gate } = gateWith([true, false]);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: file });
    const alsoBefore = gate.snapshot({ path: other });
    for (const [p, c] of alsoBefore) before.set(p, c);
    writeFileSync(file, 'bad main');
    writeFileSync(other, 'bad helper');

    await gate.review(before, 'file_write');

    expect(readFileSync(file, 'utf8')).toBe('good main');
    expect(readFileSync(other, 'utf8')).toBe('good helper');
  });

  it('counts the checks it ran', async () => {
    const { gate, checkCount } = gateWith([true, true, true]);
    await gate.establishBaseline();
    await gate.review(gate.snapshot({ path: file }), 'file_write');
    expect(gate.stats.checks).toBe(2);
    expect(checkCount()).toBe(2);
  });
});
