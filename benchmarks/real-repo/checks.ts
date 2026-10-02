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
 * A third program, the secondary regression score (`regressionScoreSource`),
 * is a measurement like the hidden score: recorded outside `oracle` mode,
 * never shown to an agent, never part of a decision.
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
  'visible-f2p': 'visible-f2p: the instance\'s FAIL_TO_PASS tests are applied to the repository at setup and named in the task; the check re-applies the test patch and passes when every FAIL_TO_PASS test passes (PASS_TO_PASS is not judged). Test-given setting: these are the upstream fix\'s own tests; the same FAIL_TO_PASS set is the hidden FAIL_TO_PASS set, so, apart from flaky tests or timeouts, check/hidden disagreement can only come from PASS_TO_PASS.',
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

/**
 * Run test targets (pytest paths or Django labels) without writing bytecode;
 * needs KIND, ACTIVATE, sh, q and parse.
 */
const PY_RUN_TESTS = [
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
];

/**
 * Run `targets` with the given modules at their base-commit versions, putting
 * the current versions back in a finally: whatever happens, the modules end as
 * they were. Needs BASE and run_tests.
 */
const PY_AT_BASE = [
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
    ...PY_RUN_TESTS,
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
    ...PY_AT_BASE,
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

// ── secondary regression score (reporting only) ────────────────────

/** Most existing test files the secondary regression score runs. */
export const MAX_SECONDARY_TEST_FILES = 5;
/** In-container hard bound on one secondary test run: `timeout -s KILL`. */
export const SECONDARY_RUN_TIMEOUT_S = 420;
/**
 * The program's own bound past that: it then kills every process in the
 * run's session, and waits at most 10 s more for the pipe to close.
 */
export const SECONDARY_KILL_GRACE_S = 30;
/** Worst case of one bounded run inside the program. */
const secondaryRunBoundS = (runTimeoutS: number, killGraceS: number): number => runTimeoutS + killGraceS + 10;
/**
 * The host's timeout on the whole program: strictly longer than its two
 * bounded runs (now, and at base) plus a margin for the git reads, so the
 * program always ends on its own, with its modules put back, before the host
 * gives up on it. A host timeout only kills `docker exec`, not the program.
 */
export const SECONDARY_HOST_TIMEOUT_MS = (2 * secondaryRunBoundS(SECONDARY_RUN_TIMEOUT_S, SECONDARY_KILL_GRACE_S) + 120) * 1000;

/**
 * One test run of the secondary score, bounded so that it really stops:
 * `timeout -s KILL` ends the runner and its process group inside the
 * container, and past RUN_TIMEOUT + KILL_GRACE the program kills every process
 * in the run's session (a test that started its own process group included).
 * `subprocess.run(..., timeout=)` is not enough on the Python 3.6 images: it
 * waits for every grandchild holding the pipe.
 */
const PY_SECONDARY_RUN = [
  'def kill_session(sid):',
  '    for name in os.listdir("/proc"):',
  '        if name.isdigit():',
  '            try:',
  '                if os.getsid(int(name)) == sid:',
  '                    os.kill(int(name), signal.SIGKILL)',
  '            except OSError:',
  '                pass',
  '',
  'def run_bounded(c):',
  '    p = subprocess.Popen(["bash", "-lc", c], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd="/testbed", start_new_session=True)',
  '    timed_out = False',
  '    try:',
  '        out, _ = p.communicate(timeout=RUN_TIMEOUT + KILL_GRACE)',
  '    except subprocess.TimeoutExpired:',
  '        timed_out = True',
  '        kill_session(p.pid)',
  '        try:',
  '            out, _ = p.communicate(timeout=10)',
  '        except subprocess.TimeoutExpired:',
  '            out = b""',
  '    kill_session(p.pid)',
  '    rc = p.returncode if p.returncode is not None else 137',
  '    if rc in (124, 137) or timed_out:',
  '        timed_out = True',
  '    return (out or b"").decode("utf-8", "replace"), rc, timed_out',
  '',
  'TIMED_OUT = []',
  '',
  'def run_tests(targets, when):',
  '    if KIND == "django":',
  `        env, cmd = "${DJANGO_ENV} PYTHONDONTWRITEBYTECODE=1", "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 "`,
  '    else:',
  '        env, cmd = "PYTHONDONTWRITEBYTECODE=1", "python -m pytest -rA --tb=short -p no:cacheprovider "',
  '    c = ACTIVATE + "timeout -s KILL %d env %s %s" % (RUN_TIMEOUT, env, cmd + " ".join(q(t) for t in targets)) + " 2>&1"',
  '    log, rc, timed_out = run_bounded(c)',
  '    if timed_out:',
  '        TIMED_OUT.append(when)',
  '    return parse(log), log, rc',
  '',
];

/**
 * The changed modules at their base versions for one run. Every module is
 * read before any is replaced, and every one is written back in the finally,
 * whatever happened in between (an error, SIGTERM, SIGHUP or SIGINT, which
 * are turned into an exit that runs the finally). Only SIGKILL can stop the
 * put-back; the host timeout is set so that it never has to be used.
 */
const PY_SECONDARY_AT_BASE = [
  'def at_base(modules, targets):',
  '    saved = {}',
  '    for m in modules:',
  '        p = os.path.join("/testbed", m)',
  '        with open(p, "rb") as fh:',
  '            saved[p] = fh.read()',
  '    def stop(signum, frame):',
  '        raise SystemExit(128 + signum)',
  '    previous = {}',
  '    for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):',
  '        previous[s] = signal.signal(s, stop)',
  '    try:',
  '        for m in modules:',
  '            base = subprocess.run(["git", "show", "%s:%s" % (BASE, m)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd="/testbed")',
  '            if base.returncode != 0:',
  '                continue',
  '            with open(os.path.join("/testbed", m), "wb") as fh:',
  '                fh.write(base.stdout)',
  '        return run_tests(targets, "base")',
  '    finally:',
  '        unrestored = []',
  '        for p, data in saved.items():',
  '            try:',
  '                with open(p, "wb") as fh:',
  '                    fh.write(data)',
  '            except Exception:',
  '                unrestored.append(p)',
  '        for s, handler in previous.items():',
  '            signal.signal(s, handler)',
  '        if unrestored:',
  '            print("SECONDARY: error could not restore " + ", ".join(unrestored))',
  '',
];

/**
 * Which tests regressed: passed at base, fail now. A test file that no longer
 * collects counts too: pytest then reports the file itself (`ERROR <file>`, a
 * key without `::`) and Django a `unittest.loader._FailedTest` named after the
 * module's last part (`test_text (unittest.loader._FailedTest)`, checked in
 * the Django 3.0 image); either is a regression when tests from that file
 * passed at base. pytest stops the whole session on a collection error, so
 * the other files' tests are then not run at all; only the file that broke is
 * counted.
 */
export const PY_SECONDARY_JUDGE = [
  'def regressions(now, base, now_rc, base_rc):',
  '    failing = [t for t, ok in now.items() if not ok]',
  '    out = [t for t in failing if base.get(t) is True]',
  '    for t in failing:',
  '        if t in out:',
  '            continue',
  '        if KIND == "django":',
  '            m = re.match(r"^(\\S+) \\(unittest\\.loader\\._FailedTest(\\.\\S+)?\\)$", t)',
  '            if not m:',
  '                continue',
  '            # Django names it after the module\'s last part: "test_text (unittest.loader._FailedTest)".',
  '            module = re.compile(r"\\((?:[\\w.]*\\.)?" + re.escape(m.group(1).split(".")[-1]) + r"\\.")',
  '            lost = [b for b, ok in base.items() if ok and "_FailedTest" not in b and module.search(b)]',
  '        else:',
  '            if "::" in t:',
  '                continue',
  '            lost = [b for b, ok in base.items() if ok and b.startswith(t + "::")]',
  '        if lost:',
  '            out.append("%s (no longer runs; %d test(s) from it passed at base)" % (t, len(lost)))',
  '    if now_rc != 0 and not now and not (base_rc != 0 and not base):',
  '        out.append("(the tests no longer run)")',
  '    return out',
  '',
];

/**
 * The secondary regression score: a measurement recorded on every non-oracle
 * run, never shown to an agent and never part of a decision.
 *
 * It finds the non-test modules changed since the base commit (the repro
 * check's rule, also excluding the test patch's files), the repository's
 * tracked test files named after them (`test_<stem>.py`, `<stem>_test.py` or
 * `unittest_<stem>.py` under the test directory, minus the test patch's files,
 * at most `maxFiles`), runs them, and when any test fails runs them again with
 * the changed modules at their base versions. A regression is a test that
 * passed at base and fails now, or a test file that no longer collects
 * (`PY_SECONDARY_JUDGE`). Matching is by file name only, so coverage is
 * partial (Django's tests are mostly `tests.py`); `files 0` means nothing
 * matched, not that nothing regressed.
 *
 * Each test run is hard-bounded inside the container (`PY_SECONDARY_RUN`),
 * the base swap is always put back (`PY_SECONDARY_AT_BASE`), and the host
 * waits longer than both runs can take (`SECONDARY_HOST_TIMEOUT_MS`). It
 * writes no bytecode and leaves the repository byte-identical. Prints
 * `SECONDARY: files <n>, regressed <m>`, one `regressed: <test>` line per
 * regression, and `timed out: <now|base>` per run that hit its bound; always
 * exits 0.
 */
export function regressionScoreSource(item: SweItem, opts: { maxFiles?: number; runTimeoutS?: number; killGraceS?: number } = {}): string {
  const skip = [...new Set([...patchedFiles(item.test_patch), ...Object.keys(reproFiles(item, ''))])];
  return [
    'import os, re, signal, subprocess, sys',
    `BASE = ${JSON.stringify(item.base_commit)}`,
    `KIND = ${JSON.stringify(isDjango(item) ? 'django' : 'pytest')}`,
    `TEST_DIR = ${JSON.stringify(testDirOf(item))}`,
    `SKIP = ${JSON.stringify(skip)}`,
    `MAX_FILES = ${opts.maxFiles ?? MAX_SECONDARY_TEST_FILES}`,
    `RUN_TIMEOUT = ${opts.runTimeoutS ?? SECONDARY_RUN_TIMEOUT_S}`,
    `KILL_GRACE = ${opts.killGraceS ?? SECONDARY_KILL_GRACE_S}`,
    `ACTIVATE = ${JSON.stringify(ACTIVATE)}`,
    '',
    ...PY_HELPERS,
    ...PY_PARSERS,
    ...PY_SECONDARY_RUN,
    ...PY_SECONDARY_AT_BASE,
    ...PY_SECONDARY_JUDGE,
    'def changed_modules():',
    '    out = []',
    '    for f in sh("git diff --name-only %s" % q(BASE)).stdout.splitlines():',
    '        f = f.strip()',
    '        parts = f.split("/")',
    '        if not f.endswith(".py") or f in SKIP:',
    '            continue',
    '        if parts[0] == TEST_DIR or "tests" in parts[:-1] or "testing" in parts[:-1]:',
    '            continue',
    '        if parts[-1].startswith("test_") or parts[-1] == "conftest.py":',
    '            continue',
    '        if os.path.isfile(os.path.join("/testbed", f)):',
    '            out.append(f)',
    '    return sorted(out)',
    '',
    'def test_files(modules):',
    '    listed = sorted(sh("git ls-files %s" % q(TEST_DIR)).stdout.split())',
    '    picked = []',
    '    for m in modules:',
    '        stem = os.path.splitext(os.path.basename(m))[0]',
    '        if stem == "__init__":',
    '            stem = os.path.basename(os.path.dirname(m))',
    '        names = ("test_%s.py" % stem, "%s_test.py" % stem, "unittest_%s.py" % stem)',
    '        for t in listed:',
    '            if os.path.basename(t) in names and t not in SKIP and t not in picked:',
    '                picked.append(t)',
    '    return picked[:MAX_FILES]',
    '',
    'def targets_of(files):',
    '    if KIND == "django":',
    '        return [t[len("tests/"):-3].replace("/", ".") for t in files if t.startswith("tests/")]',
    '    return files',
    '',
    'def main():',
    '    modules = changed_modules()',
    '    files = test_files(modules)',
    '    targets = targets_of(files)',
    '    regressed = []',
    '    if targets:',
    '        now, now_log, now_rc = run_tests(targets, "now")',
    '        failing = [t for t, ok in now.items() if not ok]',
    '        if failing or (now_rc != 0 and not now):',
    '            base, base_log, base_rc = at_base(modules, targets)',
    '            regressed = regressions(now, base, now_rc, base_rc)',
    '    print("SECONDARY: files %d, regressed %d" % (len(files), len(regressed)))',
    '    for t in regressed:',
    '        print("regressed: " + t)',
    '    for when in TIMED_OUT:',
    '        print("timed out: " + when)',
    '',
    'try:',
    '    main()',
    'except Exception as err:',
    '    print("SECONDARY: error " + (str(err).splitlines() or [type(err).__name__])[0][:200])',
    'sys.exit(0)',
    '',
  ].join('\n');
}

// ── reading results ─────────────────────────────────────────────────

/** The secondary regression score (reporting only; never shown to an agent). */
export interface SecondaryScore {
  /** Existing test files run; 0 means none matched by name, not "clean" */
  files: number;
  /** Tests that passed with the changed modules at base and fail now */
  regressed: number;
  regressedTests?: string[];
  /** Runs that hit their in-container bound (`now`, `base`); their results are partial */
  timedOut?: string[];
  /** Set when the score could not be read */
  error?: string;
}

/** The first line of an error, capped: how a failed reporting measurement records why. */
export const errorLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);

/** A secondary score that could not be taken. */
export const failedSecondary = (err: unknown): SecondaryScore => ({ files: 0, regressed: 0, error: errorLine(err) });

/** Read the secondary regression score from its program's output. */
export function parseSecondary(output: string): SecondaryScore {
  const failed = output.match(/^SECONDARY: error (.*)$/m);
  if (failed) return { files: 0, regressed: 0, error: failed[1].trim().slice(0, 200) || 'error' };
  const m = output.match(/^SECONDARY: files (\d+), regressed (\d+)\s*$/m);
  if (!m) {
    const last = output.trim().split('\n').slice(-1)[0] ?? '';
    return { files: 0, regressed: 0, error: last.slice(0, 200) || 'no SECONDARY line' };
  }
  const names = [...output.matchAll(/^regressed: (.+)$/gm)].map(r => r[1].trim());
  const timedOut = [...output.matchAll(/^timed out: (\w+)/gm)].map(r => r[1]);
  return {
    files: Number(m[1]),
    regressed: Number(m[2]),
    ...(names.length > 0 ? { regressedTests: names.slice(0, 50) } : {}),
    ...(timedOut.length > 0 ? { timedOut } : {}),
  };
}

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
