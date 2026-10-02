import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  CHECK_DESCRIPTIONS,
  MAX_SECONDARY_TEST_FILES,
  PY_SECONDARY_JUDGE,
  SECONDARY_HOST_TIMEOUT_MS,
  SECONDARY_KILL_GRACE_S,
  SECONDARY_RUN_TIMEOUT_S,
  djangoModules,
  hiddenScorerSource,
  parseScore,
  parseSecondary,
  regressionScoreSource,
  reproCheckSource,
  reproFiles,
  reproPath,
  reproRunCommand,
  reproTarget,
  testProgram,
  visibleF2pSource,
} from '../real-repo/checks.js';
import { checkerSource } from '../real-repo/workload.js';
import { DJANGO_ITEM, FLASK_ITEM, ITEM } from './real-repo-fixtures.js';

const python = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0 ? 'python' : undefined;

describe('real-repo check programs', () => {
  it('reads a score from the VERIFY line and the exit status', () => {
    expect(parseScore(0, 'VERIFY: F2P 2/2, P2P 5/5\nALL REQUIRED TESTS PASS')).toEqual({ resolved: true, f2pPassed: 2, f2pTotal: 2, p2pFailed: 0, p2pTotal: 5 });
    expect(parseScore(1, 'VERIFY: F2P 1/2, P2P 3/5\nregressed: a')).toEqual({ resolved: false, f2pPassed: 1, f2pTotal: 2, p2pFailed: 2, p2pTotal: 5 });
    expect(parseScore(1, 'VERIFY: F2P 0/3')).toMatchObject({ resolved: false, f2pTotal: 3, p2pTotal: 0 });
    expect(parseScore(2, 'VERIFY: test patch did not apply')).toMatchObject({ resolved: false, error: 'VERIFY: test patch did not apply' });
    expect(parseScore(137, '')).toMatchObject({ resolved: false, error: 'exit 137' });
  });

  it('derives Django test labels the way the escalation harness does', () => {
    expect(djangoModules(['tests/queries/tests.py', 'tests/admin_views/test_adminsite.py', 'tests/app/__init__.py', 'django/x.py']))
      .toEqual(['queries.tests', 'admin_views.test_adminsite', 'app']);
  });

  it('keeps the scorer, the visible check and the oracle apart by what they judge and leave behind', () => {
    expect(hiddenScorerSource(ITEM)).toContain('JUDGE = "all"');
    expect(hiddenScorerSource(ITEM)).toContain('AFTER = "snapshot"');
    expect(visibleF2pSource(ITEM)).toContain('JUDGE = "f2p"');
    expect(visibleF2pSource(ITEM)).toContain('AFTER = "applied"');
    expect(checkerSource(DJANGO_ITEM)).toBe(testProgram(DJANGO_ITEM, { judge: 'all', after: 'base' }));
    for (const source of [hiddenScorerSource(ITEM), visibleF2pSource(FLASK_ITEM), hiddenScorerSource(DJANGO_ITEM)]) {
      expect(source).not.toContain('/tmp');
      expect(source).not.toContain('capture_output'); // Django's images run Python 3.6
    }
  });

  it('places reproduction tests where the repository runs them, under a name nothing else uses', () => {
    expect(reproPath(ITEM)).toBe('testing/test_joule_repro_check.py');
    expect(reproPath(FLASK_ITEM)).toBe('tests/test_joule_repro_check.py');
    expect(reproFiles(DJANGO_ITEM, 'X')).toEqual({ 'tests/joule_repro_check/__init__.py': '', 'tests/joule_repro_check/tests.py': 'X' });
    expect(reproTarget(DJANGO_ITEM)).toBe('joule_repro_check');
    expect(reproRunCommand(FLASK_ITEM)).toBe('python -m pytest -rA -p no:cacheprovider tests/test_joule_repro_check.py');
  });

  it('builds a repro check that removes the test it placed, with or without the existing tests', () => {
    const source = "def test_it():\n    assert 'x' == \"y\"\n";
    const full = reproCheckSource(FLASK_ITEM, source, { existing: true });
    const only = reproCheckSource(FLASK_ITEM, source, { existing: false });
    expect(full).toContain('EXISTING = True');
    expect(only).toContain('EXISTING = False');
    expect(full).toContain(`REPRO_FILES = ${JSON.stringify({ 'tests/test_joule_repro_check.py': source })}`);
    // Placed, run, and removed in a finally: a crash cannot leave it behind.
    expect(full).toMatch(/place\(\)\ntry:\n {4}r_status, r_log, r_rc = run_tests\(\[REPRO_TARGET\]\)\nfinally:\n {4}remove\(\)/);
    // Regressions are judged against the changed modules at their base versions.
    expect(full).toContain('git diff --name-only');
    expect(full).toContain('base.get(t) is True');
    // The summary comes last, where a tail-only message still shows it.
    expect(full.trim().split('\n').slice(-1)[0]).toBe('sys.exit(0 if repro_ok and not regressed else 1)');
    expect(full).not.toContain('PATCH');
  });

  it.skipIf(!python)('generates programs that are valid Python', () => {
    const programs = [
      regressionScoreSource(ITEM), regressionScoreSource(FLASK_ITEM, { maxFiles: 2 }), regressionScoreSource(DJANGO_ITEM),
      checkerSource(ITEM), checkerSource(DJANGO_ITEM), hiddenScorerSource(FLASK_ITEM), hiddenScorerSource(DJANGO_ITEM),
      visibleF2pSource(ITEM), visibleF2pSource(DJANGO_ITEM),
      reproCheckSource(ITEM, 'def test_a():\n    assert 1\n', { existing: true }),
      reproCheckSource(DJANGO_ITEM, 'from django.test import SimpleTestCase\n', { existing: false }),
    ];
    for (const program of programs) {
      const r = spawnSync(python!, ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: program, encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
  });
});

describe('secondary regression score (reporting only)', () => {
  it('builds a program that matches test files by name, excludes the test patch, and always exits 0', () => {
    const source = regressionScoreSource(FLASK_ITEM);
    expect(MAX_SECONDARY_TEST_FILES).toBe(5);
    expect(source).toContain('MAX_FILES = 5');
    expect(regressionScoreSource(FLASK_ITEM, { maxFiles: 2 })).toContain('MAX_FILES = 2');
    // The test patch's files and the reproduction test are never modules or test files here.
    expect(source).toContain(`SKIP = ${JSON.stringify(['tests/test_blueprints.py', 'tests/test_joule_repro_check.py'])}`);
    expect(source).toContain('names = ("test_%s.py" % stem, "%s_test.py" % stem, "unittest_%s.py" % stem)');
    expect(source).toContain('sh("git ls-files %s" % q(TEST_DIR))');
    // Regression = passed at base, fails now (PY_SECONDARY_JUDGE, exercised below).
    expect(source).toContain(PY_SECONDARY_JUDGE.join('\n'));
    expect(source).toContain('regressed = regressions(now, base, now_rc, base_rc)');
    expect(source).toContain('print("SECONDARY: files %d, regressed %d" % (len(files), len(regressed)))');
    // The shared prune() helper is not embedded: this program removes nothing.
    expect(source).not.toContain('def prune');
    expect(source.trim().split('\n').slice(-1)[0]).toBe('sys.exit(0)');
    // No bytecode, Python 3.6-safe, nothing in /tmp.
    expect(source).toContain('PYTHONDONTWRITEBYTECODE=1');
    expect(source).not.toContain('capture_output');
    expect(source).not.toContain('/tmp');
    // Django: labels, its own runner, pytest's test directory for pytest.
    expect(regressionScoreSource(DJANGO_ITEM)).toContain('KIND = "django"');
    expect(regressionScoreSource(DJANGO_ITEM)).toContain('SKIP = ["tests/queries/tests.py","tests/admin_views/test_adminsite.py","tests/joule_repro_check/__init__.py","tests/joule_repro_check/tests.py"]');
    expect(regressionScoreSource(ITEM)).toContain('TEST_DIR = "testing"');
  });

  it('bounds every test run inside the container and waits longer on the host than both runs can take', () => {
    const source = regressionScoreSource(FLASK_ITEM);
    expect(SECONDARY_RUN_TIMEOUT_S).toBe(420);
    expect(SECONDARY_KILL_GRACE_S).toBe(30);
    expect(source).toContain('RUN_TIMEOUT = 420');
    expect(source).toContain('KILL_GRACE = 30');
    // A hard kill of the runner's process group inside the container...
    expect(source).toContain('c = ACTIVATE + "timeout -s KILL %d env %s %s" % (RUN_TIMEOUT, env, cmd + " ".join(q(t) for t in targets)) + " 2>&1"');
    // ...and, past it, every process in the run's own session, from the program itself.
    expect(source).toContain('start_new_session=True');
    expect(source).toContain('p.communicate(timeout=RUN_TIMEOUT + KILL_GRACE)');
    expect(source).toContain('kill_session(p.pid)');
    expect(source).toContain('if os.getsid(int(name)) == sid:');
    // Not subprocess.run(..., timeout=) for the tests: on Python 3.6 it waits for grandchildren.
    expect(source).not.toMatch(/sh\(ACTIVATE \+ cmd/);
    // Each run is at most RUN_TIMEOUT + KILL_GRACE + 10 s; the host waits strictly longer than two of them.
    expect(SECONDARY_HOST_TIMEOUT_MS).toBeGreaterThan(2 * (SECONDARY_RUN_TIMEOUT_S + SECONDARY_KILL_GRACE_S + 10) * 1000);
    expect(SECONDARY_HOST_TIMEOUT_MS).toBe(1_040_000);
    // Overridable for probes.
    expect(regressionScoreSource(FLASK_ITEM, { runTimeoutS: 5, killGraceS: 3 })).toContain('RUN_TIMEOUT = 5\nKILL_GRACE = 3');
    // Runs that hit the bound are reported.
    expect(source).toContain('print("timed out: " + when)');
  });

  it('reads every module before swapping any, and puts all of them back whatever ends the run', () => {
    const source = regressionScoreSource(DJANGO_ITEM);
    const atBase = source.slice(source.indexOf('def at_base(modules, targets):'), source.indexOf('def regressions('));
    // Every module saved before the try that swaps them.
    expect(atBase.indexOf('saved[p] = fh.read()')).toBeLessThan(atBase.indexOf('    try:'));
    expect(atBase.indexOf('    try:')).toBeLessThan(atBase.indexOf('git", "show"'));
    // The put-back loops over everything saved, survives a failed write, and runs on SIGTERM/SIGHUP/SIGINT too.
    expect(atBase).toMatch(/ {4}finally:\n {8}unrestored = \[\]\n {8}for p, data in saved\.items\(\):\n {12}try:\n {16}with open\(p, "wb"\) as fh:/);
    expect(atBase).toContain('for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):');
    expect(atBase).toContain('raise SystemExit(128 + signum)');
  });

  it.skipIf(!python)('counts a test file that no longer collects as a regression (pytest and Django)', () => {
    const judge = (kind: 'pytest' | 'django', now: Record<string, boolean>, base: Record<string, boolean>, nowRc = 1, baseRc = 0): string[] => {
      const program = [
        'import json, re, sys',
        `KIND = ${JSON.stringify(kind)}`,
        ...PY_SECONDARY_JUDGE,
        'a = json.loads(sys.stdin.read())',
        'print(json.dumps(regressions(a["now"], a["base"], a["now_rc"], a["base_rc"])))',
      ].join('\n');
      const r = spawnSync(python!, ['-c', program], { input: JSON.stringify({ now, base, now_rc: nowRc, base_rc: baseRc }), encoding: 'utf8' });
      expect(r.stderr).toBe('');
      return JSON.parse(r.stdout) as string[];
    };
    // A plain regression.
    expect(judge('pytest', { 'tests/test_h.py::test_a': false, 'tests/test_h.py::test_b': true }, { 'tests/test_h.py::test_a': true, 'tests/test_h.py::test_b': true }))
      .toEqual(['tests/test_h.py::test_a']);
    // pytest: `ERROR tests/test_h.py` (a collection error) is a key without `::`.
    expect(judge('pytest', { 'tests/test_h.py': false, 'tests/test_other.py::test_c': true }, { 'tests/test_h.py::test_a': true, 'tests/test_h.py::test_b': false, 'tests/test_other.py::test_c': true }))
      .toEqual(['tests/test_h.py (no longer runs; 1 test(s) from it passed at base)']);
    // ...not a regression when nothing from that file passed at base either.
    expect(judge('pytest', { 'tests/test_h.py': false }, { 'tests/test_h.py': false })).toEqual([]);
    expect(judge('pytest', { 'tests/test_h.py': false }, { 'tests/test_h.py::test_a': false })).toEqual([]);
    // Django: an import failure is a unittest.loader._FailedTest named after the module's last part —
    // `test_text (unittest.loader._FailedTest) ... ERROR`, as the Django 3.0 image prints it.
    const base = {
      'test_slugify (utils_tests.test_text.TestUtilsText)': true,
      'test_wrap (utils_tests.test_text.TestUtilsText)': false,
      'test_other (utils_tests.test_html.TestHtml)': true,
    };
    expect(judge('django', { 'test_text (unittest.loader._FailedTest)': false, 'test_other (utils_tests.test_html.TestHtml)': true }, base))
      .toEqual(['test_text (unittest.loader._FailedTest) (no longer runs; 1 test(s) from it passed at base)']);
    // A dotted name, and the 3.11+ format, are read the same way.
    expect(judge('django', { 'utils_tests.test_text (unittest.loader._FailedTest)': false }, base)).toHaveLength(1);
    expect(judge('django', { 'test_text (unittest.loader._FailedTest.test_text)': false }, base)).toHaveLength(1);
    // Another module's failure does not claim this module's tests; a failure at base too is no regression.
    expect(judge('django', { 'test_crypto (unittest.loader._FailedTest)': false }, base)).toEqual([]);
    expect(judge('django', { 'test_text (unittest.loader._FailedTest)': false }, { 'test_text (unittest.loader._FailedTest)': false })).toEqual([]);
    // Nothing parsed now, while the base run worked: the tests no longer run at all.
    expect(judge('pytest', {}, { 'tests/test_h.py::test_a': true }, 2, 0)).toEqual(['(the tests no longer run)']);
    expect(judge('pytest', {}, {}, 2, 2)).toEqual([]);
  });

  it('reads the score, its regressions and its failures', () => {
    expect(parseSecondary('SECONDARY: files 2, regressed 1\nregressed: tests/test_h.py (no longer runs; 3 test(s) from it passed at base)\ntimed out: base\n'))
      .toEqual({ files: 2, regressed: 1, regressedTests: ['tests/test_h.py (no longer runs; 3 test(s) from it passed at base)'], timedOut: ['base'] });
    expect(parseSecondary('collected 3 items\nSECONDARY: files 2, regressed 0\n')).toEqual({ files: 2, regressed: 0 });
    expect(parseSecondary('SECONDARY: files 1, regressed 2\nregressed: tests/test_a.py::test_x\nregressed: test_y (app.tests.T)\n'))
      .toEqual({ files: 1, regressed: 2, regressedTests: ['tests/test_a.py::test_x', 'test_y (app.tests.T)'] });
    // files 0 is a measurement (nothing matched), not an error.
    expect(parseSecondary('SECONDARY: files 0, regressed 0')).toEqual({ files: 0, regressed: 0 });
    expect(parseSecondary('SECONDARY: error [Errno 2] No such file')).toEqual({ files: 0, regressed: 0, error: '[Errno 2] No such file' });
    expect(parseSecondary('Traceback ...\nKilled')).toEqual({ files: 0, regressed: 0, error: 'Killed' });
    expect(parseSecondary('')).toEqual({ files: 0, regressed: 0, error: 'no SECONDARY line' });
  });

  it('names the test-given setting in the visible-f2p manifest description only', () => {
    expect(CHECK_DESCRIPTIONS['visible-f2p']).toContain('Test-given setting: these are the upstream fix\'s own tests; the same FAIL_TO_PASS set is the hidden FAIL_TO_PASS set, so, apart from flaky tests or timeouts, check/hidden disagreement can only come from PASS_TO_PASS.');
  });

  // What the program can change, read from its syntax tree: it writes files only
  // inside at_base (the modules' base versions, then the current versions back
  // in its finally), removes nothing, and runs no git command that changes the
  // index or the working tree.
  const AUDIT_PY = [
    'import ast, json, sys',
    'tree = ast.parse(sys.stdin.read())',
    'out = {"writes": [], "restores": 0, "removes": [], "pruneCalls": 0, "git": [], "strings": []}',
    'def text(n):',
    '    return n.value if isinstance(n, ast.Constant) and isinstance(n.value, str) else None',
    'def visit(node, func, in_finally):',
    '    if isinstance(node, ast.FunctionDef):',
    '        func = node.name',
    '    if isinstance(node, ast.Try):',
    '        for n in node.body + node.handlers + node.orelse:',
    '            visit(n, func, in_finally)',
    '        for n in node.finalbody:',
    '            visit(n, func, True)',
    '        return',
    '    if isinstance(node, ast.Call):',
    '        f = node.func',
    '        name = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else "")',
    '        if name == "open" and len(node.args) > 1 and text(node.args[1]) is not None and any(c in text(node.args[1]) for c in "wa+"):',
    '            out["writes"].append(func)',
    '            if func == "at_base" and in_finally:',
    '                out["restores"] += 1',
    '        owner = f.value.id if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) else ""',
    '        if owner in ("os", "shutil") and name in ("remove", "unlink", "rmdir", "rmtree", "removedirs", "mkdir", "makedirs", "rename", "replace"):',
    '            out["removes"].append("%s:%s" % (func, name))',
    '        if name == "prune":',
    '            out["pruneCalls"] += 1',
    '        if name == "run" and node.args and isinstance(node.args[0], ast.List):',
    '            out["git"].append(" ".join(text(e) for e in node.args[0].elts[:2] if text(e) is not None))',
    '    if text(node) is not None:',
    '        out["strings"].append(text(node))',
    '    for child in ast.iter_child_nodes(node):',
    '        visit(child, func, in_finally)',
    'visit(tree, None, False)',
    'print(json.dumps(out))',
  ].join('\n');

  it.skipIf(!python)('can only change the changed modules, inside at_base, and puts them back in its finally', () => {
    for (const item of [ITEM, FLASK_ITEM, DJANGO_ITEM]) {
      const r = spawnSync(python!, ['-c', AUDIT_PY], { input: regressionScoreSource(item), encoding: 'utf8' });
      expect(r.stderr).toBe('');
      const tree = JSON.parse(r.stdout) as { writes: string[]; restores: number; removes: string[]; pruneCalls: number; git: string[]; strings: string[] };
      expect(tree.writes.length).toBeGreaterThan(0);
      expect(new Set(tree.writes)).toEqual(new Set(['at_base']));
      expect(tree.restores).toBe(1);
      // Nothing is removed (the shared prune() helper is not embedded at all).
      expect(tree.removes).toEqual([]);
      expect(tree.pruneCalls).toBe(0);
      // sh() runs bash -lc <command>; the only direct subprocess is git show (read-only).
      expect(tree.git.sort()).toEqual(['bash -lc', 'git show']);
      const gitCommands = tree.strings.filter(s => /\bgit\s/.test(s));
      expect(gitCommands.sort()).toEqual(['git diff --name-only %s', 'git ls-files %s']);
      for (const s of tree.strings) expect(s).not.toMatch(/git (add|checkout|apply|stash|reset|clean|rm)\b/);
    }
  });
});
