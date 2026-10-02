/**
 * The programs that judge a real-repository run, as Python sources.
 *
 * Every one of them lives on the host and is piped into the instance's
 * container on stdin (see `runCheck` in workload.ts); none leaves a file
 * behind. There are two jobs, kept apart:
 *
 *   - the CHECK: what the gate and the escalation verifier run, and whose
 *     output the agents see. Its source depends on the check mode.
 *   - the hidden SCORE: the SWE-bench criterion (FAIL_TO_PASS and
 *     PASS_TO_PASS with the instance's test patch), used only to grade a run.
 *     Outside `oracle` mode no agent ever sees it.
 *
 * Check modes:
 *   oracle       the hidden SWE-bench tests are the check (the setting of every
 *                real-repository run before 2026-10-02; an oracle, not a check a
 *                user would have)
 *   repro        a reproduction test written for the issue by a separate agent
 *                that never saw the hidden tests, plus the repository's existing
 *                tests for the modules the agents changed
 *   visible-f2p  the instance's FAIL_TO_PASS tests, applied to the repository
 *                from the start and named in the task
 *
 * Two test runners are supported: pytest (pytest, pylint, flask, …) and
 * Django's runtests.py, ported from harness/workloads/swebench.ts.
 */

import type { SweItem } from './workload.js';

export type CheckMode = 'oracle' | 'repro' | 'visible-f2p';
export const CHECK_MODES: readonly CheckMode[] = ['oracle', 'repro', 'visible-f2p'];

/** What agents are told each check is (the policy `label`). */
export const CHECK_LABELS: Record<CheckMode, string> = {
  oracle: "the repository's check",
  repro: "the issue's reproduction test and the existing tests for the modules you changed",
  'visible-f2p': 'the failing tests named in the task',
};

/** One line per mode for manifests. */
export const CHECK_DESCRIPTIONS: Record<CheckMode, string> = {
  oracle: 'ORACLE: the check is the hidden SWE-bench checker (hidden test patch, FAIL_TO_PASS and PASS_TO_PASS); its output, including failing hidden-test names, reaches the agents. Not a check a user would have.',
  repro: 'repro: the check is a reproduction test generated per issue by a separate agent that saw only the issue and the repository (stored on the host, piped in at check time, removed afterwards), plus up to 3 existing test files named test_<module>.py for each non-test module changed since the base commit (git diff --name-only), where a test counts as a regression only if it passed with those modules at their base versions',
  'visible-f2p': 'visible-f2p: the instance\'s FAIL_TO_PASS tests are applied to the repository at setup and named in the task; the check re-applies the test patch and passes when every FAIL_TO_PASS test passes (PASS_TO_PASS is not judged)',
};

export const patchedFiles = (patch: string): string[] =>
  [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map(m => m[2]);

export const shQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const isDjango = (item: Pick<SweItem, 'repo'>): boolean => item.repo === 'django/django';

/** The repository's test directory. */
export const testDirOf = (item: Pick<SweItem, 'repo'>): string => (item.repo === 'pytest-dev/pytest' ? 'testing' : 'tests');

/**
 * Bytecode pytest may have left for the hidden test files: compiled hidden
 * tests are hidden tests. Checks no longer write it; this removes what older
 * checks left in a reused container.
 */
export function bytecodeCleanup(files: readonly string[]): string {
  return files
    .filter(f => f.endsWith('.py'))
    .map(f => {
      const slash = f.lastIndexOf('/');
      const dir = slash >= 0 ? f.slice(0, slash + 1) : '';
      const stem = f.slice(slash + 1, -'.py'.length);
      return `rm -f ${shQuote(`${dir}__pycache__/${stem}`)}.*.pyc`;
    })
    .join('; ');
}

/** Django test labels for test files, the way harness/workloads/swebench.ts derives them. */
export function djangoModules(files: readonly string[]): string[] {
  return files
    .filter(f => f.startsWith('tests/') && f.endsWith('.py'))
    .map(f => f.slice('tests/'.length, -'.py'.length).replace(/\//g, '.').replace(/\.__init__$/, ''));
}

const ACTIVATE = 'source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; ';

/**
 * Django's runner needs a UTF-8 locale: the images default to ASCII, and
 * migrations print "…". The official SWE-bench evaluation sets the same.
 */
export const DJANGO_ENV = 'LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 PYTHONIOENCODING=utf8 LANGUAGE=en_US:en';

/** The command that runs an instance's hidden-test files, without writing bytecode. */
export function hiddenTestCommand(item: SweItem): string {
  const files = patchedFiles(item.test_patch);
  if (isDjango(item)) {
    return `${DJANGO_ENV} PYTHONDONTWRITEBYTECODE=1 ./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 ${djangoModules(files).join(' ')}`;
  }
  return `PYTHONDONTWRITEBYTECODE=1 python -m pytest -rA --tb=short -p no:cacheprovider ${files.map(f => shQuote(f)).join(' ')}`;
}

/** How an agent runs the tests itself, for the task text. */
export function testHint(item: SweItem): string {
  if (isDjango(item)) {
    return 'Tests: this is the Django source tree (no manage.py, no pytest). Run a test module with: '
      + 'python tests/runtests.py --settings=test_sqlite --parallel 1 <module>, e.g. python tests/runtests.py '
      + '--settings=test_sqlite --parallel 1 admin_views.test_adminsite (module = path under tests/ with dots).';
  }
  return 'Tests: run a test file with: python -m pytest -x -q path/to/test_x.py';
}

// ── shared Python pieces ────────────────────────────────────────────

const PY_HELPERS = [
  'def q(s):',
  '    return "\'" + s.replace("\'", "\'\\\\\'\'") + "\'"',
  '',
  'def sh(c, data=None, **kw):',
  '    io = {"input": data} if data is not None else {"stdin": subprocess.DEVNULL}',
  // stdout/stderr pipes rather than capture_output: Django's images run Python 3.6.
  '    return subprocess.run(["bash", "-lc", c], stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8", errors="replace", cwd="/testbed", **io, **kw)',
  '',
];

/** Test-result parsers: pytest's -rA summary, and Django's verbose runner (as in swebench.ts). */
const PY_PARSERS = [
  'def parse_pytest(log):',
  '    status = {}',
  '    for line in log.splitlines():',
  '        m = re.match(r"^(PASSED|FAILED|ERROR)\\s+(\\S+)", line.strip())',
  '        if m:',
  '            status[m.group(2)] = m.group(1) == "PASSED"',
  '    return status',
  '',
  'def parse_django(log):',
  '    # Whatever precedes " ... <status>" is the test\'s name; for a test with a',
  '    # docstring that is the docstring\'s first line (the SWE-bench rule).',
  '    status = {}',
  '    for raw in log.splitlines():',
  '        m = re.match(r"^(.+?) \\.\\.\\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$", raw.strip())',
  '        if m:',
  '            status[m.group(1)] = m.group(2) == "ok"',
  '    return status',
  '',
  'def parse(log):',
  '    return parse_django(log) if KIND == "django" else parse_pytest(log)',
  '',
];

/** Remove now-empty directories from `d` up to (not including) /testbed. */
const PY_PRUNE = [
  'def prune(d):',
  '    while d.startswith("/testbed/") and os.path.isdir(d) and not os.listdir(d):',
  '        os.rmdir(d)',
  '        d = os.path.dirname(d)',
  '',
];

export type TestProgramJudge = 'all' | 'f2p';
/**
 * What the program leaves behind:
 *   base      test files back at the base commit (what the oracle check does)
 *   snapshot  test files exactly as they were before it ran (hidden scoring:
 *             a score must not change the run it measures)
 *   applied   the test patch stays applied (visible-f2p)
 */
export type TestProgramAfter = 'base' | 'snapshot' | 'applied';

/**
 * A program that lays the instance's test patch over the working tree, runs
 * the patched test files, and judges FAIL_TO_PASS (and PASS_TO_PASS, with
 * judge 'all'). Prints `VERIFY: F2P a/b[, P2P c/d]` first; exits 0 only when
 * every judged test passed.
 */
export function testProgram(item: SweItem, opts: { judge: TestProgramJudge; after: TestProgramAfter }): string {
  const files = patchedFiles(item.test_patch);
  return [
    'import os, re, subprocess, sys',
    `BASE = ${JSON.stringify(item.base_commit)}`,
    `KIND = ${JSON.stringify(isDjango(item) ? 'django' : 'pytest')}`,
    `FILES = ${JSON.stringify(files)}`,
    `F2P = ${JSON.stringify(JSON.parse(item.FAIL_TO_PASS) as string[])}`,
    `P2P = ${JSON.stringify(JSON.parse(item.PASS_TO_PASS) as string[])}`,
    `PATCH = ${JSON.stringify(item.test_patch)}`,
    `BYTECODE_CLEANUP = ${JSON.stringify(bytecodeCleanup(files))}`,
    `RUN = ${JSON.stringify(`${ACTIVATE}${hiddenTestCommand(item)} 2>&1`)}`,
    `JUDGE = ${JSON.stringify(opts.judge)}`,
    `AFTER = ${JSON.stringify(opts.after)}`,
    '',
    ...PY_HELPERS,
    ...PY_PARSERS,
    ...PY_PRUNE,
    'def to_base():',
    '    # Each test file back to the base commit; one the patch added is removed.',
    '    for f in FILES:',
    '        if sh("git cat-file -e %s" % q(BASE + ":" + f)).returncode == 0:',
    '            sh("git checkout -q %s -- %s" % (BASE, q(f)))',
    '        else:',
    '            p = os.path.join("/testbed", f)',
    '            if os.path.isfile(p):',
    '                os.remove(p)',
    '            prune(os.path.dirname(p))',
    '    if BYTECODE_CLEANUP:',
    '        sh(BYTECODE_CLEANUP)',
    '',
    'def snapshot():',
    '    snap = {}',
    '    for f in FILES:',
    '        p = os.path.join("/testbed", f)',
    '        if os.path.isfile(p):',
    '            with open(p, "rb") as fh:',
    '                snap[f] = fh.read()',
    '        else:',
    '            snap[f] = None',
    '    return snap',
    '',
    'def put_back(snap):',
    '    for f, data in snap.items():',
    '        p = os.path.join("/testbed", f)',
    '        if data is None:',
    '            continue',
    '        d = os.path.dirname(p)',
    '        if not os.path.isdir(d):',
    '            os.makedirs(d)',
    '        with open(p, "wb") as fh:',
    '            fh.write(data)',
    '',
    'SNAP = snapshot() if AFTER == "snapshot" else None',
    '',
    'def finish():',
    '    if AFTER == "base":',
    '        to_base()',
    '    elif AFTER == "snapshot":',
    '        to_base()',
    '        put_back(SNAP)',
    '    elif BYTECODE_CLEANUP:',
    '        sh(BYTECODE_CLEANUP)',
    '',
    'to_base()',
    'applied = sh("git apply --whitespace=nowarn -", data=PATCH)',
    'if applied.returncode != 0:',
    '    finish()',
    '    print("VERIFY: test patch did not apply"); sys.exit(2)',
    '',
    'try:',
    '    run = sh(RUN, timeout=900)',
    '    log = run.stdout + run.stderr',
    'except subprocess.TimeoutExpired:',
    '    log = "VERIFY: the tests timed out"',
    'finish()',
    '',
    'status = parse(log)',
    'f2p_bad = [t for t in F2P if status.get(t) is not True]',
    'p2p_bad = [] if JUDGE == "f2p" else [t for t in P2P if status.get(t) is not True]',
    'if JUDGE == "f2p":',
    '    print("VERIFY: F2P %d/%d" % (len(F2P) - len(f2p_bad), len(F2P)))',
    'else:',
    '    print("VERIFY: F2P %d/%d, P2P %d/%d" % (len(F2P) - len(f2p_bad), len(F2P), len(P2P) - len(p2p_bad), len(P2P)))',
    'if f2p_bad:',
    '    print("still failing: " + ", ".join(f2p_bad[:6]))',
    'if p2p_bad:',
    '    print("regressed: " + ", ".join(p2p_bad[:6]))',
    'if not f2p_bad and not p2p_bad:',
    '    print("ALL REQUIRED TESTS PASS")',
    '    sys.exit(0)',
    'tail = [l for l in log.splitlines() if l.strip()][-12:]',
    'print("\\n".join(tail))',
    'sys.exit(1)',
    '',
  ].join('\n');
}

/** The hidden SWE-bench score: judges everything, leaves the repository exactly as it found it. */
export const hiddenScorerSource = (item: SweItem): string => testProgram(item, { judge: 'all', after: 'snapshot' });

/** The visible-f2p check: FAIL_TO_PASS only, tests left applied. */
export const visibleF2pSource = (item: SweItem): string => testProgram(item, { judge: 'f2p', after: 'applied' });

// ── reproduction tests ──────────────────────────────────────────────

/** Name used for the reproduction test, chosen so it cannot collide with a real test. */
const REPRO_NAME = 'joule_repro_check';

/** Where the reproduction-test author writes the test (and where the check places it). */
export function reproPath(item: Pick<SweItem, 'repo'>): string {
  return isDjango(item) ? `tests/${REPRO_NAME}/tests.py` : `${testDirOf(item)}/test_${REPRO_NAME}.py`;
}

/** Every file the check places for a reproduction test (Django needs a test package). */
export function reproFiles(item: Pick<SweItem, 'repo'>, source: string): Record<string, string> {
  return isDjango(item)
    ? { [`tests/${REPRO_NAME}/__init__.py`]: '', [reproPath(item)]: source }
    : { [reproPath(item)]: source };
}

/** What to hand the runner to run just the reproduction test. */
export function reproTarget(item: Pick<SweItem, 'repo'>): string {
  return isDjango(item) ? REPRO_NAME : reproPath(item);
}

/** How the reproduction-test author runs its test. */
export function reproRunCommand(item: Pick<SweItem, 'repo'>): string {
  return isDjango(item)
    ? `python tests/runtests.py --settings=test_sqlite --parallel 1 ${REPRO_NAME}`
    : `python -m pytest -rA -p no:cacheprovider ${reproPath(item)}`;
}

/** Most existing test files the repro check runs for changed modules. */
export const MAX_EXISTING_TEST_FILES = 3;

/**
 * The repro check: place the reproduction test, run it, remove it; then, with
 * `existing`, run the repository's own tests for the modules changed since the
 * base commit and fail on any test that passed with those modules at their
 * base versions. Exits 0 only when the reproduction test passes (at least one
 * test, none failing) and nothing regressed. The summary is printed last, so a
 * message that shows only the end of the output still carries it.
 */
export function reproCheckSource(item: SweItem, source: string, opts: { existing: boolean }): string {
  return [
    'import os, re, subprocess, sys',
    `BASE = ${JSON.stringify(item.base_commit)}`,
    `KIND = ${JSON.stringify(isDjango(item) ? 'django' : 'pytest')}`,
    `TEST_DIR = ${JSON.stringify(testDirOf(item))}`,
    `REPRO_FILES = ${JSON.stringify(reproFiles(item, source))}`,
    `REPRO_TARGET = ${JSON.stringify(reproTarget(item))}`,
    `EXISTING = ${opts.existing ? 'True' : 'False'}`,
    `MAX_EXISTING = ${MAX_EXISTING_TEST_FILES}`,
    `ACTIVATE = ${JSON.stringify(ACTIVATE)}`,
    '',
    ...PY_HELPERS,
    ...PY_PARSERS,
    ...PY_PRUNE,
    'def run_tests(targets):',
    '    if KIND == "django":',
    `        cmd = "${DJANGO_ENV} PYTHONDONTWRITEBYTECODE=1 ./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 "`,
    '    else:',
    '        cmd = "PYTHONDONTWRITEBYTECODE=1 python -m pytest -rA --tb=short -p no:cacheprovider "',
    '    try:',
    '        r = sh(ACTIVATE + cmd + " ".join(q(t) for t in targets) + " 2>&1", timeout=600)',
    '        log, rc = r.stdout + r.stderr, r.returncode',
    '    except subprocess.TimeoutExpired:',
    '        log, rc = "the tests timed out", 124',
    '    return parse(log), log, rc',
    '',
    'created, kept = [], {}',
    '',
    'def place():',
    '    for path, src in REPRO_FILES.items():',
    '        p = os.path.join("/testbed", path)',
    '        if os.path.isfile(p):',
    '            with open(p, "rb") as fh:',
    '                kept[p] = fh.read()',
    '        missing, d = [], os.path.dirname(p)',
    '        while not os.path.isdir(d):',
    '            missing.append(d)',
    '            d = os.path.dirname(d)',
    '        for m in reversed(missing):',
    '            os.mkdir(m)',
    '            created.append(m)',
    '        with open(p, "w", encoding="utf-8") as fh:',
    '            fh.write(src)',
    '',
    'def remove():',
    '    for path in REPRO_FILES:',
    '        p = os.path.join("/testbed", path)',
    '        if p in kept:',
    '            with open(p, "wb") as fh:',
    '                fh.write(kept[p])',
    '        elif os.path.isfile(p):',
    '            os.remove(p)',
    '        stem = os.path.splitext(os.path.basename(p))[0]',
    '        cache = os.path.join(os.path.dirname(p), "__pycache__")',
    '        if os.path.isdir(cache):',
    '            for name in os.listdir(cache):',
    '                if name.startswith(stem + "."):',
    '                    os.remove(os.path.join(cache, name))',
    '            prune(cache)',
    '    for d in reversed(created):',
    '        prune(d)',
    '',
    'def changed_modules():',
    '    out = []',
    '    for f in sh("git diff --name-only %s" % q(BASE)).stdout.splitlines():',
    '        f = f.strip()',
    '        parts = f.split("/")',
    '        if not f.endswith(".py") or f in REPRO_FILES:',
    '            continue',
    '        if parts[0] == TEST_DIR or "tests" in parts[:-1] or "testing" in parts[:-1]:',
    '            continue',
    '        if parts[-1].startswith("test_") or parts[-1] == "conftest.py":',
    '            continue',
    '        if os.path.isfile(os.path.join("/testbed", f)):',
    '            out.append(f)',
    '    return sorted(out)',
    '',
    'def tests_for(modules):',
    '    listed = sorted(sh("git ls-files %s" % q(TEST_DIR)).stdout.split())',
    '    picked = []',
    '    for m in modules:',
    '        stem = os.path.splitext(os.path.basename(m))[0]',
    '        if stem == "__init__":',
    '            stem = os.path.basename(os.path.dirname(m))',
    '        for t in listed:',
    '            if os.path.basename(t) == "test_%s.py" % stem and t not in picked:',
    '                picked.append(t)',
    '    picked = picked[:MAX_EXISTING]',
    '    if KIND == "django":',
    '        return [t[len("tests/"):-3].replace("/", ".") for t in picked if t.startswith("tests/")]',
    '    return picked',
    '',
    'def at_base(modules, targets):',
    '    saved = {}',
    '    try:',
    '        for m in modules:',
    '            base = subprocess.run(["git", "show", "%s:%s" % (BASE, m)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd="/testbed")',
    '            if base.returncode != 0:',
    '                continue',
    '            p = os.path.join("/testbed", m)',
    '            with open(p, "rb") as fh:',
    '                saved[p] = fh.read()',
    '            with open(p, "wb") as fh:',
    '                fh.write(base.stdout)',
    '        return run_tests(targets)',
    '    finally:',
    '        for p, data in saved.items():',
    '            with open(p, "wb") as fh:',
    '                fh.write(data)',
    '',
    'place()',
    'try:',
    '    r_status, r_log, r_rc = run_tests([REPRO_TARGET])',
    'finally:',
    '    remove()',
    'r_pass = sum(1 for ok in r_status.values() if ok)',
    'r_fail = len(r_status) - r_pass',
    'repro_ok = r_rc == 0 and r_pass > 0 and r_fail == 0',
    '',
    'regressed, ran = [], []',
    'if EXISTING:',
    '    modules = changed_modules()',
    '    ran = tests_for(modules)',
    '    if ran:',
    '        now, now_log, now_rc = run_tests(ran)',
    '        broken_now = now_rc != 0 and not now',
    '        failing = [t for t, ok in now.items() if not ok]',
    '        if failing or broken_now:',
    '            base, base_log, base_rc = at_base(modules, ran)',
    '            regressed = [t for t in failing if base.get(t) is True]',
    '            if broken_now and not (base_rc != 0 and not base):',
    '                last = [l for l in now_log.splitlines() if l.strip()][-1:]',
    '                regressed.append("(the existing tests no longer run: %s)" % (last[0] if last else "no output"))',
    '',
    'print("\\n".join([l for l in r_log.splitlines() if l.strip()][-15:]))',
    'print("CHECK: reproduction test %s (%d passed, %d failed)" % ("PASSED" if repro_ok else "FAILED", r_pass, r_fail))',
    'if EXISTING:',
    '    if ran:',
    '        print("CHECK: existing tests for the changed modules (%s): %s" % (", ".join(ran), "regressed: " + ", ".join(regressed[:6]) if regressed else "no regressions"))',
    '    else:',
    '        print("CHECK: no existing test files matched the changed modules")',
    'sys.exit(0 if repro_ok and not regressed else 1)',
    '',
  ].join('\n');
}

// ── reading results ─────────────────────────────────────────────────

/** A hidden-test score: the SWE-bench criterion on the repository's state. */
export interface HiddenScore {
  resolved: boolean;
  f2pPassed: number;
  f2pTotal: number;
  p2pFailed: number;
  p2pTotal: number;
  /** Set when the score could not be read (patch did not apply, no VERIFY line) */
  error?: string;
}

/** Read a scoring program's result from its exit status and VERIFY line. */
export function parseScore(status: number, output: string): HiddenScore {
  const m = output.match(/VERIFY: F2P (\d+)\/(\d+)(?:, P2P (\d+)\/(\d+))?/);
  if (!m) {
    const line = output.split('\n').find(l => l.startsWith('VERIFY:')) ?? output.trim().split('\n').slice(-1)[0] ?? '';
    return { resolved: false, f2pPassed: 0, f2pTotal: 0, p2pFailed: 0, p2pTotal: 0, error: line.slice(0, 200) || `exit ${status}` };
  }
  const p2pPassed = m[3] !== undefined ? Number(m[3]) : 0;
  const p2pTotal = m[4] !== undefined ? Number(m[4]) : 0;
  return {
    resolved: status === 0,
    f2pPassed: Number(m[1]),
    f2pTotal: Number(m[2]),
    p2pFailed: p2pTotal - p2pPassed,
    p2pTotal,
  };
}
