import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditWorkspace } from '@joule/shared';
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

  it('names a labelled check in its messages and never shows the command', async () => {
    const outputs = [true, false, false];
    let i = 0;
    const run = async (): Promise<CheckResult> => {
      const passed = outputs[Math.min(i++, outputs.length - 1)];
      return { passed, output: passed ? 'ALL REQUIRED TESTS PASS' : 'VERIFY: F2P 0/1' };
    };
    const command = 'node run-check.ts joule-rr-x C:/host/check.py';
    const gate = new VerifiedEditGate({ command, label: "the repository's check" }, undefined, undefined, run);
    writeFileSync(file, 'good');
    await gate.establishBaseline();

    const before = gate.snapshot({ path: file });
    writeFileSync(file, 'bad');
    const rolledBack = await gate.review(before, 'file_write');
    expect(rolledBack.message).toContain("Output of the repository's check: VERIFY: F2P 0/1");
    expect(rolledBack.message).not.toContain(command);

    // Once nothing passes, the "did not pass" wording names it too.
    const failing = new VerifiedEditGate({ command, label: "the repository's check" }, undefined, undefined, async () => ({ passed: false, output: 'VERIFY: F2P 0/1' }));
    await failing.establishBaseline();
    const kept = await failing.review(failing.snapshot({ path: file }), 'file_write');
    expect(kept.message).toBe("Verification (the repository's check) did not pass after this edit: VERIFY: F2P 0/1");
  });

  it('keeps its original wording without a label', async () => {
    const { gate } = gateWith([false, false]);
    await gate.establishBaseline();
    const kept = await gate.review(gate.snapshot({ path: file }), 'file_write');
    expect(kept.message).toBe('Verification did not pass after this edit: FAIL: assertion error');

    const { gate: guarded } = gateWith([true, false]);
    writeFileSync(file, 'good');
    await guarded.establishBaseline();
    const before = guarded.snapshot({ path: file });
    writeFileSync(file, 'bad');
    expect((await guarded.review(before, 'file_write')).message).toBe(
      'Your edit was rolled back: it turned a passing state into a failing one. '
      + 'The previous working version has been restored. Check output: FAIL: assertion error',
    );
  });

  it('counts the checks it ran', async () => {
    const { gate, checkCount } = gateWith([true, true, true]);
    await gate.establishBaseline();
    await gate.review(gate.snapshot({ path: file }), 'file_write');
    expect(gate.stats.checks).toBe(2);
    expect(checkCount()).toBe(2);
  });
});

/**
 * A stand-in for a repository inside a container: files the host cannot see,
 * reachable only through the workspace. Every operation is recorded so a test
 * can show the gate went through it and nowhere else.
 */
function fakeContainer(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const ops: string[] = [];
  const workspace: EditWorkspace = {
    read: path => { ops.push(`read ${path}`); return files.get(path) ?? null; },
    write: (path, content) => { ops.push(`write ${path}`); files.set(path, content); },
    remove: path => { ops.push(`remove ${path}`); files.delete(path); },
  };
  return { files, ops, workspace };
}

function containerGate(results: boolean[], workspace: EditWorkspace) {
  let i = 0;
  const run = async (): Promise<CheckResult> => {
    const passed = results[Math.min(i++, results.length - 1)];
    return { passed, output: passed ? 'ALL REQUIRED TESTS PASS' : 'VERIFY: F2P 0/1' };
  };
  return new VerifiedEditGate({ command: 'noop', workspace }, undefined, undefined, run);
}

describe('VerifiedEditGate with a supplied workspace', () => {
  // A container path the host does not have: a gate that read the host would
  // snapshot "missing" and, on rollback, try to delete a host file.
  const containerPath = 'src/_pytest/joule_gate_container_only.py';

  it('snapshots through the workspace, not the host filesystem', () => {
    const repo = fakeContainer({ [containerPath]: 'fixed = True\n' });
    const gate = containerGate([true], repo.workspace);

    const before = gate.snapshot({ path: containerPath });

    expect(before.get(containerPath)).toBe('fixed = True\n');
    expect(existsSync(containerPath)).toBe(false);
    expect(repo.ops).toEqual([`read ${containerPath}`]);
  });

  it('restores the verified content inside the workspace after a regression', async () => {
    const repo = fakeContainer({ [containerPath]: 'fixed = True\n' });
    const gate = containerGate([true, false], repo.workspace);
    await gate.establishBaseline();

    // The reviewer's fix verified; the tester now edits the container and breaks it.
    const before = gate.snapshot({ path: containerPath });
    repo.files.set(containerPath, 'fixed = BROKEN\n');
    const decision = await gate.review(before, 'repo_edit', 'tester');

    expect(decision).toMatchObject({ kept: false, rolledBack: true });
    expect(repo.files.get(containerPath)).toBe('fixed = True\n');
    expect(repo.ops).toEqual([`read ${containerPath}`, `write ${containerPath}`]);
    expect(gate.stats.byAuthor.tester).toEqual({ proposed: 1, accepted: 0, rolledBack: 1 });
    expect(existsSync(containerPath)).toBe(false);
  });

  it('removes a file the rejected write created in the workspace', async () => {
    const repo = fakeContainer({});
    const gate = containerGate([true, false], repo.workspace);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: containerPath });
    repo.files.set(containerPath, 'new but broken\n');
    const decision = await gate.review(before, 'repo_write');

    expect(decision.rolledBack).toBe(true);
    expect(repo.files.has(containerPath)).toBe(false);
    expect(repo.ops).toEqual([`read ${containerPath}`, `remove ${containerPath}`]);
  });

  it('leaves the workspace alone when the write keeps it passing', async () => {
    const repo = fakeContainer({ [containerPath]: 'v1\n' });
    const gate = containerGate([true, true], repo.workspace);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: containerPath });
    repo.files.set(containerPath, 'v2\n');
    const decision = await gate.review(before, 'repo_edit');

    expect(decision).toMatchObject({ kept: true, rolledBack: false });
    expect(repo.files.get(containerPath)).toBe('v2\n');
    expect(repo.ops).toEqual([`read ${containerPath}`]);
  });

  it('says the version was restored only when the restore happened', async () => {
    const repo = fakeContainer({ [containerPath]: 'fixed = True\n' });
    const gate = containerGate([true, false], repo.workspace);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: containerPath });
    repo.files.set(containerPath, 'fixed = BROKEN\n');
    const decision = await gate.review(before, 'repo_edit');

    expect(decision.message).toContain('The previous working version has been restored');
    expect(repo.files.get(containerPath)).toBe('fixed = True\n');
    expect(gate.stats).toMatchObject({ rollbacks: 1, restoreFailures: 0 });
  });

  it('tells the truth and records no rollback when the restore fails', async () => {
    const repo = fakeContainer({ [containerPath]: 'fixed = True\n' });
    const failing: EditWorkspace = {
      ...repo.workspace,
      write: () => { throw new Error('container is not running'); },
    };
    const gate = containerGate([true, false, false], failing);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: containerPath });
    repo.files.set(containerPath, 'fixed = BROKEN\n');
    const decision = await gate.review(before, 'repo_edit', 'tester');

    // The broken edit is still there, and the agent is told so.
    expect(repo.files.get(containerPath)).toBe('fixed = BROKEN\n');
    expect(decision).toMatchObject({ kept: true, rolledBack: false });
    expect(decision.message).not.toContain('has been restored');
    expect(decision.message).toContain('restoring the previous version FAILED');
    expect(decision.message).toContain(`${containerPath} (container is not running)`);
    expect(gate.stats).toMatchObject({ rollbacks: 0, restoreFailures: 1, proposed: 1, accepted: 0, verified: false });
    expect(gate.stats.byAuthor.tester).toEqual({ proposed: 1, accepted: 0, rolledBack: 0 });

    // No verified state is left to protect, so the repair is not rolled back.
    const repair = gate.snapshot({ path: containerPath });
    repo.files.set(containerPath, 'fixed = STILL_WORKING_ON_IT\n');
    expect(await gate.review(repair, 'repo_edit', 'tester')).toMatchObject({ kept: true, rolledBack: false });
    expect(gate.stats.restoreFailures).toBe(1);
  });

  it('restores the files it can when one of several fails', async () => {
    const other = 'src/_pytest/joule_gate_other.py';
    const repo = fakeContainer({ [containerPath]: 'a = 1\n', [other]: 'b = 1\n' });
    const partly: EditWorkspace = {
      ...repo.workspace,
      write: (path, content) => {
        if (path === containerPath) throw new Error('permission denied');
        repo.workspace.write(path, content);
      },
    };
    const gate = containerGate([true, false], partly);
    await gate.establishBaseline();

    const before = gate.snapshot({ path: containerPath });
    for (const [p, c] of gate.snapshot({ path: other })) before.set(p, c);
    repo.files.set(containerPath, 'a = BROKEN\n');
    repo.files.set(other, 'b = BROKEN\n');
    const decision = await gate.review(before, 'repo_write');

    expect(repo.files.get(other)).toBe('b = 1\n');
    expect(decision.rolledBack).toBe(false);
    expect(decision.message).toContain(`${containerPath} (permission denied)`);
    expect(decision.message).not.toContain(other);
    expect(gate.stats).toMatchObject({ rollbacks: 0, restoreFailures: 1 });
  });
});
