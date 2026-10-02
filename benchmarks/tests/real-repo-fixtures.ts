/**
 * Shared fixtures for the real-repo harness tests: SWE-bench-shaped items and
 * a `docker` stand-in. Not a test file itself.
 */

import type { DockerRun, SweItem } from '../real-repo/workload.js';

export const TEST_PATCH = [
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

export const ITEM: SweItem = {
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

export const FLASK_ITEM: SweItem = {
  repo: 'pallets/flask',
  instance_id: 'pallets__flask-0002',
  base_commit: 'def456',
  patch: 'diff --git a/src/flask/blueprints.py b/src/flask/blueprints.py\n',
  test_patch: [
    'diff --git a/tests/test_blueprints.py b/tests/test_blueprints.py',
    '--- a/tests/test_blueprints.py',
    '+++ b/tests/test_blueprints.py',
    '@@ -1 +1,2 @@',
    ' import flask',
    '+def test_dotted_name(): pass',
    '',
  ].join('\n'),
  problem_statement: 'Raise error when blueprint name contains a dot',
  version: '2.0',
  FAIL_TO_PASS: JSON.stringify(['tests/test_blueprints.py::test_dotted_name']),
  PASS_TO_PASS: JSON.stringify(['tests/test_blueprints.py::test_blueprint_specific_error_handling']),
};

export const DJANGO_ITEM: SweItem = {
  repo: 'django/django',
  instance_id: 'django__django-0003',
  base_commit: 'aaa111',
  patch: 'diff --git a/django/db/models/query.py b/django/db/models/query.py\n',
  test_patch: [
    'diff --git a/tests/queries/tests.py b/tests/queries/tests.py',
    '--- a/tests/queries/tests.py',
    '+++ b/tests/queries/tests.py',
    '@@ -1 +1,2 @@',
    ' from django.test import TestCase',
    '+class Q(TestCase):\n    def test_new(self): pass',
    'diff --git a/tests/admin_views/test_adminsite.py b/tests/admin_views/test_adminsite.py',
    '--- a/tests/admin_views/test_adminsite.py',
    '+++ b/tests/admin_views/test_adminsite.py',
    '@@ -1 +1,2 @@',
    ' import x',
    '+y = 1',
    '',
  ].join('\n'),
  problem_statement: 'QuerySet does the wrong thing',
  version: '4.0',
  FAIL_TO_PASS: JSON.stringify(['test_new (queries.tests.Q)']),
  PASS_TO_PASS: JSON.stringify(['test_site (admin_views.test_adminsite.SiteTests)', 'A docstring-named test.']),
};

/**
 * A container behind the `docker` CLI, without Docker. It keeps the files in
 * /tmp (seeded with what an older run left there) and records every call, so a
 * test can show what the harness put in the container and what it piped in.
 * `answer` decides what a piped program (`python -`) prints and returns.
 */
export function fakeDocker(legacy: string[] = [], answer?: (program: string) => { stdout: string; status: number }) {
  const tmp = new Set(legacy);
  const calls: string[][] = [];
  const piped: string[] = [];
  const execs: string[] = [];
  const inputs: Array<{ command: string; input: string }> = [];
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
    if (opts.input !== undefined) inputs.push({ command, input: opts.input });
    if (command === 'python -') {
      piped.push(opts.input ?? '');
      if (answer) {
        const a = answer(opts.input ?? '');
        return { stdout: a.stdout, stderr: '', status: a.status };
      }
      return { stdout: 'VERIFY: F2P 0/1, P2P 1/1\nstill failing: testing/test_existing.py::test_hidden_regression\n', stderr: '', status: 1 };
    }
    if (command.startsWith('rm -f /tmp/')) {
      for (const f of [...tmp]) if (command.includes(f)) tmp.delete(f);
      return ok();
    }
    if (command.startsWith('git ')) return ok();
    throw new Error(`unexpected command: ${command}`);
  };
  return { run, tmp, calls, piped, execs, inputs };
}
