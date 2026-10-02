import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  djangoModules,
  hiddenScorerSource,
  parseScore,
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
