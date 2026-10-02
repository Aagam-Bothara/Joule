import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatePolicy } from '../crew-scaling/tasks.js';
import {
  CHECK_LABEL,
  checkerSource,
  prepareInstance,
  runCheck,
  type DockerRun,
  type SweItem,
} from '../real-repo/workload.js';

const TEST_PATCH = [
  'diff --git a/testing/test_existing.py b/testing/test_existing.py',
  '--- a/testing/test_existing.py',
  '+++ b/testing/test_existing.py',
  '@@ -1 +1,2 @@',
  ' import pytest',
  '+def test_hidden_regression(): assert "naïve" == "naïve"',
  'diff --git a/testing/test_added.py b/testing/test_added.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/testing/test_added.py',
  '@@ -0,0 +1 @@',
  "+def test_hidden_new(): assert 'it''s'",
  '',
].join('\n');

const ITEM: SweItem = {
  repo: 'pytest-dev/pytest',
  instance_id: 'pytest-dev__pytest-0001',
  base_commit: 'abc123',
  patch: '',
  test_patch: TEST_PATCH,
  problem_statement: 'Something is broken.',
  version: '8.0',
  FAIL_TO_PASS: JSON.stringify(['testing/test_existing.py::test_hidden_regression']),
  PASS_TO_PASS: JSON.stringify(['testing/test_added.py::test_hidden_new']),
};

/**
 * A container behind the `docker` CLI, without Docker. It keeps the files in
 * /tmp (seeded with what an older run left there) and records every call, so a
 * test can show what the harness put in the container and what it piped in.
 */
function fakeDocker(legacy: string[] = []) {
  const tmp = new Set(legacy);
  const calls: string[][] = [];
  const piped: string[] = [];
  const execs: string[] = [];
  const run: DockerRun = (args, opts = {}) => {
    calls.push(args);
    const ok = (stdout = '') => ({ stdout, stderr: '', status: 0 });
    if (args[0] === 'inspect') return ok('true\n');
    if (args[0] === 'cp') {
      tmp.add(args[2].split(':')[1]);
      return ok();
    }
    if (args[0] !== 'exec') throw new Error(`unexpected docker ${args.join(' ')}`);
    const command = args[args.length - 1].split('cd /testbed && ')[1];
    execs.push(command);
    if (command === 'python -') {
      piped.push(opts.input ?? '');
      return { stdout: 'VERIFY: F2P 0/1, P2P 1/1\nstill failing: testing/test_existing.py::test_hidden_regression\n', stderr: '', status: 1 };
    }
    if (command.startsWith('rm -f /tmp/')) {
      for (const f of [...tmp]) if (command.includes(f)) tmp.delete(f);
      return ok();
    }
    if (command.startsWith('git ')) return ok();
    throw new Error(`unexpected command: ${command}`);
  };
  return { run, tmp, calls, piped, execs };
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'joule-rr-workload-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('real-repo checker placement', () => {
  it('leaves nothing in the container: not after prepare, not after a check', () => {
    const docker = fakeDocker(['/tmp/test.patch', '/tmp/check.py']);
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root });

    // A reused container's leftovers are gone, and nothing new was copied in.
    expect([...docker.tmp]).toEqual([]);
    expect(docker.calls.some(a => a[0] === 'cp')).toBe(false);

    const verdict = prepared.verify();
    expect(verdict.success).toBe(false);
    expect([...docker.tmp]).toEqual([]);
    expect(docker.calls.some(a => a[0] === 'cp')).toBe(false);

    // The only commands naming /tmp are the ones removing the old files.
    const naming = docker.execs.filter(c => c.includes('/tmp/'));
    expect(naming.every(c => c.startsWith('rm -f /tmp/test.patch /tmp/check.py'))).toBe(true);
  });

  it('pipes the host-side checker in on stdin for every check', () => {
    const docker = fakeDocker();
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root });
    const checker = join(root, 'unit', ITEM.instance_id, 'check.py');

    prepared.verify();
    runCheck(prepared.container, checker, docker.run);

    expect(docker.piped).toHaveLength(2);
    for (const input of docker.piped) expect(input).toBe(readFileSync(checker, 'utf8'));
    const exec = docker.calls.find(a => a[0] === 'exec' && a[a.length - 1].endsWith('python -'))!;
    expect(exec.slice(0, 3)).toEqual(['exec', '-i', prepared.container]);
    // The patch is kept on the host beside the checker, for inspection.
    expect(readFileSync(join(root, 'unit', ITEM.instance_id, 'test.patch'), 'utf8')).toBe(TEST_PATCH);
  });

  it('gives the gate a host command that needs nothing in the container, and a label to show', () => {
    const docker = fakeDocker();
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root });
    const policy = gatePolicy(prepared);

    expect(policy.command).toMatch(/^node ".*cli\.mjs" ".*run-check\.ts" "joule-rr-unit-pytest-dev__pytest-0001" ".*check\.py"$/);
    expect(policy.command).not.toContain('/tmp/');
    expect(policy.label).toBe(CHECK_LABEL);
    expect(policy.workspace).toBeDefined();
  });

  it('builds a checker that carries the patch itself and cleans up after the tests', () => {
    const source = checkerSource(ITEM);

    expect(source).not.toContain('/tmp');
    // Applied from memory, not from a file.
    expect(source).toContain('git apply --whitespace=nowarn -');
    expect(source).toContain(`PATCH = ${JSON.stringify(TEST_PATCH)}`);
    // No compiled copies of the hidden tests are written...
    expect(source).toContain('PYTHONDONTWRITEBYTECODE=1 python -m pytest');
    // ...and any an older check left are removed, per hidden-test file.
    expect(source).toContain("rm -f 'testing/__pycache__/test_existing'.*.pyc; rm -f 'testing/__pycache__/test_added'.*.pyc");
    // A file the patch added is removed rather than left behind.
    expect(source).toContain('git cat-file -e');
    expect(source).toContain('sh("rm -f -- %s" % q(f))');
    // The test files are restored even if the tests time out.
    expect(source).toContain('except subprocess.TimeoutExpired');
  });
});
