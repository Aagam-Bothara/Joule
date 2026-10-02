import { describe, expect, it } from 'vitest';
import { MAX_SCANNED_UNTRACKED, auditDiff, f2pFunctionNames, isTestNamed, untrackedToScan } from '../real-repo/audit.js';
import { DJANGO_ITEM, FLASK_ITEM, ITEM } from './real-repo-fixtures.js';

/** A `git diff -U0` block adding `lines` to `file`. */
const block = (file: string, lines: string[], opts: { newFile?: boolean } = {}): string => [
  `diff --git a/${file} b/${file}`,
  ...(opts.newFile ? ['new file mode 100644', 'index 0000000..1111111', '--- /dev/null'] : ['index 1111111..2222222 100644', `--- a/${file}`]),
  `+++ b/${file}`,
  `@@ -10,0 +11,${lines.length} @@ def f():`,
  ...lines.map(l => `+${l}`),
].join('\n');

describe('diff audit', () => {
  it('ignores the visible test files in visible-f2p mode (the check lays them again), but not in repro mode', () => {
    const diff = [
      block('testing/test_existing.py', ['def test_hidden_regression(): assert "naïve" == "naïve"']),
      block('src/_pytest/main.py', ['    return value']),
    ].join('\n');
    const visible = auditDiff(diff, ['testing/test_added.py'], ITEM, 'visible-f2p');
    expect(visible).toEqual({ changedFiles: ['src/_pytest/main.py'], testInfraChanged: [], testFilesAdded: [], suspicious: [] });

    const repro = auditDiff(diff, ['testing/test_added.py'], ITEM, 'repro');
    expect(repro.changedFiles).toEqual(['testing/test_existing.py', 'src/_pytest/main.py', 'testing/test_added.py']);
    expect(repro.testInfraChanged).toEqual(['testing/test_existing.py']);
    expect(repro.testFilesAdded).toEqual(['testing/test_added.py']);
  });

  it('always leaves out the reproduction test', () => {
    expect(auditDiff('', ['testing/test_joule_repro_check.py'], ITEM, 'repro').changedFiles).toEqual([]);
    expect(auditDiff('', ['tests/joule_repro_check/__init__.py', 'tests/joule_repro_check/tests.py'], DJANGO_ITEM, 'repro').changedFiles).toEqual([]);
  });

  it('flags test infrastructure: conftest, configuration, test directories, Django runner files', () => {
    const diff = [
      block('conftest.py', ['collect_ignore = ["x"]']),
      block('setup.cfg', ['addopts = -p no:x']),
      block('pyproject.toml', ['[tool.pytest.ini_options]']),
      block('tox.ini', ['x']),
      block('pytest.ini', ['x']),
      block('tests/helpers.py', ['x = 1']),
      block('src/flask/test_util_test.py', ['x = 1']),
      block('src/flask/app.py', ['x = 1']),
    ].join('\n');
    const audit = auditDiff(diff, [], FLASK_ITEM, 'visible-f2p');
    expect(audit.testInfraChanged).toEqual(['conftest.py', 'setup.cfg', 'pyproject.toml', 'tox.ini', 'pytest.ini', 'tests/helpers.py', 'src/flask/test_util_test.py']);
    expect(audit.suspicious).toEqual([]);

    const django = auditDiff([block('tests/runtests.py', ['x']), block('tests/test_sqlite.py', ['x'])].join('\n'), [], DJANGO_ITEM, 'visible-f2p');
    expect(django.testInfraChanged).toEqual(['tests/runtests.py', 'tests/test_sqlite.py']);
  });

  it('lists new test files without flagging them, but flags a new conftest.py', () => {
    const audit = auditDiff('', ['tests/test_new_behaviour.py', 'tests/reproduce_test.py', 'scratch.py', 'tests/conftest.py'], FLASK_ITEM, 'visible-f2p');
    expect(audit.testFilesAdded).toEqual(['tests/test_new_behaviour.py', 'tests/reproduce_test.py']);
    expect(audit.testInfraChanged).toEqual(['tests/conftest.py']);
    expect(audit.changedFiles).toEqual(['tests/test_new_behaviour.py', 'tests/reproduce_test.py', 'scratch.py', 'tests/conftest.py']);
  });

  it('flags added source lines that name a FAIL_TO_PASS test or detect a test run', () => {
    const diff = block('src/flask/blueprints.py', [
      '    if "test_dotted_name" in os.environ.get("PYTEST_CURRENT_TEST", ""):',
      "    if 'pytest' in sys.modules:",
      '    if "pytest" in sys.modules: return',
      '    name = test_dotted_names_helper()',
      '    raise ValueError("dots are not allowed")',
    ]);
    const audit = auditDiff(diff, [], FLASK_ITEM, 'visible-f2p');
    expect(audit.suspicious).toEqual([
      { file: 'src/flask/blueprints.py', reason: 'names FAIL_TO_PASS test test_dotted_name', line: 'if "test_dotted_name" in os.environ.get("PYTEST_CURRENT_TEST", ""):' },
      { file: 'src/flask/blueprints.py', reason: 'reads PYTEST_CURRENT_TEST', line: 'if "test_dotted_name" in os.environ.get("PYTEST_CURRENT_TEST", ""):' },
      { file: 'src/flask/blueprints.py', reason: "checks 'pytest' in sys.modules", line: "if 'pytest' in sys.modules:" },
      { file: 'src/flask/blueprints.py', reason: "checks 'pytest' in sys.modules", line: 'if "pytest" in sys.modules: return' },
    ]);
    // Removed lines and context are not added lines; test files are not where this is looked for.
    const removed = 'diff --git a/src/x.py b/src/x.py\n--- a/src/x.py\n+++ b/src/x.py\n@@ -3 +2,0 @@\n-    PYTEST_CURRENT_TEST';
    expect(auditDiff(removed, [], FLASK_ITEM, 'visible-f2p').suspicious).toEqual([]);
    expect(auditDiff(block('tests/test_x.py', ['PYTEST_CURRENT_TEST']), [], FLASK_ITEM, 'visible-f2p').suspicious).toEqual([]);
  });

  it('reads FAIL_TO_PASS function names from pytest and Django ids', () => {
    expect(f2pFunctionNames({ FAIL_TO_PASS: JSON.stringify([
      'testing/test_a.py::TestX::test_param[a-b]',
      'testing/test_a.py::test_plain',
      'tests/test_b.py::test_plain',
      'test_new (queries.tests.Q)',
      'test_ordering (admin_views.test_adminsite.SiteTests)',
      'A docstring-named test.',
    ]) })).toEqual(['test_new', 'test_ordering', 'test_param', 'test_plain']);
    expect(f2pFunctionNames(DJANGO_ITEM)).toEqual(['test_new']);
    // A Django id in source is flagged by its function name.
    const audit = auditDiff(block('django/db/models/query.py', ['        if self._test_new or "test_new" in name:']), [], DJANGO_ITEM, 'visible-f2p');
    expect(audit.suspicious.map(s => s.reason)).toEqual(['names FAIL_TO_PASS test test_new']);
  });

  it('knows test file names', () => {
    expect(isTestNamed('tests/test_x.py')).toBe(true);
    expect(isTestNamed('pkg/x_test.py')).toBe(true);
    expect(isTestNamed('pkg/testing.py')).toBe(false);
    expect(isTestNamed('pkg/test_x.txt')).toBe(false);
  });

  it('scans the contents of new untracked source files, not of new test files', () => {
    const untracked = ['src/flask/_shim.py', 'tests/test_new_behaviour.py', 'notes.txt'];
    expect(untrackedToScan(untracked, FLASK_ITEM, 'visible-f2p')).toEqual(['src/flask/_shim.py']);
    const audit = auditDiff('', untracked, FLASK_ITEM, 'visible-f2p', {
      'src/flask/_shim.py': 'import os, sys\nIN_TESTS = sys.modules.get("pytest") is not None\n',
      // Not scanned even if handed over: a test file is not where this is looked for.
      'tests/test_new_behaviour.py': 'PYTEST_CURRENT_TEST',
    });
    expect(audit.suspicious).toEqual([{ file: 'src/flask/_shim.py', reason: "checks sys.modules.get('pytest')", line: 'IN_TESTS = sys.modules.get("pytest") is not None' }]);
    expect(audit.testFilesAdded).toEqual(['tests/test_new_behaviour.py']);
    // The scan is capped in number of files.
    const many = Array.from({ length: MAX_SCANNED_UNTRACKED + 5 }, (_, i) => `src/m${i}.py`);
    expect(untrackedToScan(many, FLASK_ITEM, 'visible-f2p')).toHaveLength(MAX_SCANNED_UNTRACKED);
  });

  it("detects sys.modules.get('pytest') in either quoting, in tracked diffs too", () => {
    const audit = auditDiff(block('src/flask/app.py', ["    if sys.modules.get('pytest'):", '    if sys.modules.get( "pytest" ):', '    if sys.modules.get("pytest_cov"): pass']), [], FLASK_ITEM, 'visible-f2p');
    expect(audit.suspicious.map(s => s.line)).toEqual(["if sys.modules.get('pytest'):", 'if sys.modules.get( "pytest" ):']);
  });

  it('flags untracked sitecustomize.py, usercustomize.py and .pth files as test infrastructure', () => {
    const audit = auditDiff('', ['sitecustomize.py', 'src/usercustomize.py', 'joule.pth', 'src/flask/util.py'], FLASK_ITEM, 'visible-f2p');
    expect(audit.testInfraChanged).toEqual(['sitecustomize.py', 'src/usercustomize.py', 'joule.pth']);
    // A tracked one changed is flagged too.
    expect(auditDiff(block('sitecustomize.py', ['import x']), [], FLASK_ITEM, 'visible-f2p').testInfraChanged).toEqual(['sitecustomize.py']);
  });

  it('flags test files deleted, or renamed out of the test tree, by their old path', () => {
    const deleted = [
      'diff --git a/tests/test_helpers.py b/tests/test_helpers.py',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/tests/test_helpers.py',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-def test_a(): pass',
      '-def test_b(): pass',
    ].join('\n');
    const gone = auditDiff(deleted, [], FLASK_ITEM, 'visible-f2p');
    expect(gone.testFilesRemoved).toEqual(['tests/test_helpers.py']);
    expect(gone.testInfraChanged).toEqual(['tests/test_helpers.py']);

    const renamed = [
      'diff --git a/tests/test_helpers.py b/src/flask/helpers_checks.py',
      'similarity index 100%',
      'rename from tests/test_helpers.py',
      'rename to src/flask/helpers_checks.py',
    ].join('\n');
    const moved = auditDiff(renamed, [], FLASK_ITEM, 'visible-f2p');
    expect(moved.testFilesRemoved).toEqual(['tests/test_helpers.py']);
    expect(moved.testInfraChanged).toEqual(['tests/test_helpers.py']);
    expect(moved.changedFiles).toEqual(['src/flask/helpers_checks.py']);

    // Re-added elsewhere does not clear it; a source file deleted is not a removed test.
    const readded = auditDiff(deleted, ['tests/other/test_helpers.py'], FLASK_ITEM, 'visible-f2p');
    expect(readded.testFilesRemoved).toEqual(['tests/test_helpers.py']);
    const source = deleted.replace(/tests\/test_helpers\.py/g, 'src/flask/old.py');
    expect(auditDiff(source, [], FLASK_ITEM, 'visible-f2p').testFilesRemoved).toBeUndefined();
    // The visible tests themselves are left out in visible-f2p: the check lays them again.
    const visible = deleted.replace(/tests\/test_helpers\.py/g, 'tests/test_blueprints.py');
    expect(auditDiff(visible, [], FLASK_ITEM, 'visible-f2p')).toMatchObject({ testInfraChanged: [], changedFiles: [] });
  });

  it('strips a trailing parametrisation before splitting a pytest id on ::', () => {
    expect(f2pFunctionNames({ FAIL_TO_PASS: JSON.stringify(['testing/test_a.py::test_x[a::b]', 'testing/test_a.py::TestK::test_y[1-a::c-d]']) }))
      .toEqual(['test_x', 'test_y']);
  });
});
