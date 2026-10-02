import { describe, expect, it } from 'vitest';
import type { EditWorkspace } from '@joule/shared';
import { gatePolicy, type PreparedTask } from '../crew-scaling/tasks.js';
import { editRepoFile } from '../harness/workloads/repo-python-guard.js';
import { containerWorkspace } from '../harness/workloads/repo-workspace.js';

/**
 * A repository behind `docker exec`, without Docker: the shell commands the
 * workspace and the repo tools send are interpreted against an in-memory tree.
 */
function fakeContainer(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const commands: string[] = [];
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const unquote = (s: string) => s.replace(/'\\''/g, "'");
  const run = (command: string, _timeoutMs: number, input?: string) => {
    commands.push(command);
    let m: RegExpMatchArray | null;
    if ((m = command.match(/^if \[ -e '(.+)' \]; then cat '.+'; else exit 44; fi$/))) {
      const content = files.get(unquote(m[1]));
      return content === undefined ? { status: 44, stdout: '', stderr: '' } : ok(content);
    }
    if ((m = command.match(/^mkdir -p "\$\(dirname '.+'\)" && cat > '(.+)'$/)) || (m = command.match(/^cat > '(.+)'$/))) {
      files.set(unquote(m[1]), input ?? '');
      return ok();
    }
    if ((m = command.match(/^cat '(.+)'$/))) {
      const content = files.get(unquote(m[1]));
      return content === undefined ? { status: 1, stdout: '', stderr: 'No such file or directory' } : ok(content);
    }
    if ((m = command.match(/^rm -f '(.+)'$/))) {
      files.delete(unquote(m[1]));
      return ok();
    }
    if (command.startsWith('python -m py_compile')) return ok();
    throw new Error(`unexpected command: ${command}`);
  };
  return { files, commands, run };
}

describe('container workspace for the verified-edit gate', () => {
  it('reads a file from the repository, relative to /testbed', () => {
    const repo = fakeContainer({ 'src/_pytest/pathlib.py': 'fixed\n' });
    const ws = containerWorkspace(repo.run);
    expect(ws.read('src/_pytest/pathlib.py')).toBe('fixed\n');
    expect(ws.read('/testbed/src/_pytest/pathlib.py')).toBe('fixed\n');
    expect(repo.commands[0]).toBe("if [ -e 'src/_pytest/pathlib.py' ]; then cat 'src/_pytest/pathlib.py'; else exit 44; fi");
  });

  it('reports a missing file as null, not as a failure', () => {
    const ws = containerWorkspace(fakeContainer({}).run);
    expect(ws.read('new_module.py')).toBeNull();
  });

  it('refuses to snapshot when the container cannot be read', () => {
    const ws = containerWorkspace(() => ({ status: 1, stdout: '', stderr: 'Error response from daemon: container is not running' }));
    expect(() => ws.read('module.py')).toThrow('cannot snapshot module.py: Error response from daemon');
  });

  it('writes and removes files inside the container', () => {
    const repo = fakeContainer({});
    const ws = containerWorkspace(repo.run);
    ws.write('/testbed/pkg/new.py', 'x = 1\n');
    expect(repo.files.get('pkg/new.py')).toBe('x = 1\n');
    ws.remove('pkg/new.py');
    expect(repo.files.has('pkg/new.py')).toBe(false);
    expect(repo.commands).toEqual([
      'mkdir -p "$(dirname \'pkg/new.py\')" && cat > \'pkg/new.py\'',
      "rm -f 'pkg/new.py'",
    ]);
  });

  it('throws when a restore does not land, so the gate never counts it as a rollback', () => {
    const ws = containerWorkspace(() => ({ status: 125, stdout: '', stderr: 'No such container: joule-rr-x' }));
    expect(() => ws.write('module.py', 'good')).toThrow('cannot restore module.py: No such container');
    expect(() => ws.remove('module.py')).toThrow('cannot remove module.py');
  });

  it('quotes paths for the shell', () => {
    const repo = fakeContainer({ "it's.py": 'ok\n' });
    expect(containerWorkspace(repo.run).read("it's.py")).toBe('ok\n');
    expect(repo.commands[0]).toContain("'it'\\''s.py'");
  });

  it('puts back what a later repo_edit broke (the pytest-11148 sequence)', () => {
    // The reviewer's fix is in the container and the check passes; the gate
    // snapshots through the workspace before the tester's edit runs.
    const verified = 'def import_path(p):\n    return sys.modules[name]\n';
    const repo = fakeContainer({ 'src/_pytest/pathlib.py': verified });
    const ws = containerWorkspace(repo.run);
    const before = ws.read('src/_pytest/pathlib.py');

    // The tester's edit goes through the real tool code, on the same files.
    editRepoFile('src/_pytest/pathlib.py', 'return sys.modules[name]', 'return importlib.import_module(name)', repo.run);
    expect(repo.files.get('src/_pytest/pathlib.py')).not.toBe(verified);

    // The check now fails; the gate restores the snapshot.
    ws.write('src/_pytest/pathlib.py', before as string);
    expect(repo.files.get('src/_pytest/pathlib.py')).toBe(verified);
  });
});

describe('gate policy for a prepared task', () => {
  const prepared = (extra: Partial<PreparedTask>): PreparedTask => ({
    dir: '/sandbox/task', description: 'd', verify: () => ({ success: true, output: '' }), ...extra,
  });

  it('is unchanged for the authored benchmarks: host tests, host files', () => {
    expect(gatePolicy(prepared({}))).toEqual({ command: 'python run_tests.py', cwd: '/sandbox/task', timeoutMs: 30_000 });
  });

  it('is unchanged for a workload command without a workspace', () => {
    expect(gatePolicy(prepared({ verifyCommand: 'docker exec c check' }))).toEqual({ command: 'docker exec c check', timeoutMs: 900_000 });
  });

  it('carries the workload\'s workspace through to the gate', () => {
    const workspace: EditWorkspace = { read: () => null, write: () => {}, remove: () => {} };
    const policy = gatePolicy(prepared({ verifyCommand: 'docker exec c check', workspace }));
    expect(policy).toMatchObject({ command: 'docker exec c check', timeoutMs: 900_000 });
    expect(policy.workspace).toBe(workspace);
  });
});
