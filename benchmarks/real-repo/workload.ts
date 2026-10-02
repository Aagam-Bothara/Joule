/**
 * Real-repository validation: SWE-bench Lite instances as staged-recovery workloads.
 *
 * Everything the authored fixtures provided synthetically, this provides for
 * real: a repository someone else wrote, an issue someone else reported, and
 * hidden tests the agent never sees. The crew works inside the instance's
 * official SWE-bench image, and the verifier is the SWE-bench criterion —
 * apply the instance's test patch over the agent's work and require every
 * FAIL_TO_PASS and PASS_TO_PASS test to pass.
 *
 * The checker (a Python program with the test patch embedded in it) lives on
 * the host, never in the container. Each check pipes it into the container on
 * stdin; it restores the test files, applies the hidden tests from memory,
 * runs them without writing bytecode, parses the result, and puts the test
 * files back. Nothing it uses stays in the container between checks, so an
 * agent working there has no hidden test, test name or checker to find. Its
 * exit code is the whole signal: 0 only when the instance is genuinely solved.
 *
 * Runs made before this change were not like this: they copied the checker and
 * the test patch to /tmp in the agent's container, where any agent with
 * repo_shell could read them.
 *
 * Scope: pytest-driven repositories (pytest, pylint, flask) — the development
 * pool — and Django, whose runtests.py runner and log format are ported from
 * harness/workloads/swebench.ts for the held-out pool. sympy is not supported.
 *
 * What the gate and escalation run is the check mode's program (checks.ts):
 * `oracle` (the hidden checker above, every earlier run's setting), `repro`
 * or `visible-f2p`. Outside oracle mode the hidden tests only score runs
 * (`scoreHidden`), and no agent sees that score.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PreparedTask } from '../crew-scaling/tasks.js';
import type { ScalingWorkload } from '../crew-scaling/runner.js';
import { containerWorkspace } from '../harness/workloads/repo-workspace.js';
import {
  CHECK_LABELS,
  bytecodeCleanup,
  hiddenScorerSource,
  isDjango,
  parseScore,
  patchedFiles,
  reproCheckSource,
  shQuote,
  testHint,
  testProgram,
  visibleF2pSource,
  type CheckMode,
  type HiddenScore,
} from './checks.js';

export interface SweItem {
  repo: string;
  instance_id: string;
  base_commit: string;
  patch: string;
  test_patch: string;
  problem_statement: string;
  version: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
}

export const ARTIFACT_ROOT = resolve('benchmarks/.sandbox/real-repo');

/** What the gate and the recovery handoff call the check, instead of printing its command. */
export const CHECK_LABEL = "the repository's check";

/**
 * Where checker files lived in the container before they were kept on the
 * host. A container reused from such a run still has them, so preparing an
 * instance removes them.
 */
const LEGACY_CONTAINER_FILES = ['/tmp/test.patch', '/tmp/check.py'];

/**
 * The container the tools should act on.
 *
 * Tools are registered once but every task has its own container, so the
 * workload publishes which one is live. Runs are sequential, so one value is
 * enough and there is no window in which it is ambiguous.
 */
let activeContainer = '';
export const currentContainer = (): string => {
  if (activeContainer === '') throw new Error('no repository is prepared: the tools have nothing to act on');
  return activeContainer;
};
const ISSUE_CAP = 6000;

export const imageFor = (id: string): string => `swebench/sweb.eval.x86_64.${id.replace('__', '_1776_')}:latest`;
export const containerFor = (id: string, slot: string): string =>
  `joule-rr-${slot}-${id}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

export interface DockerResult { stdout: string; stderr: string; status: number }
/** One `docker` invocation; injectable so the container plumbing can be tested without Docker. */
export type DockerRun = (args: string[], opts?: { input?: string; timeoutMs?: number }) => DockerResult;

const realDocker: DockerRun = (args, opts = {}) => {
  const r = spawnSync('docker', args, {
    encoding: 'utf8', input: opts.input, timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : ''), status: r.status ?? (r.error ? 124 : 1) };
};

/** Run a command inside the instance's conda environment at /testbed. */
export function inRepo(container: string, command: string, timeoutMs = 300_000, input?: string, docker: DockerRun = realDocker): DockerResult {
  const wrapped = `source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; cd /testbed && ${command}`;
  return docker(['exec', ...(input !== undefined ? ['-i'] : []), container, 'bash', '-c', wrapped], { input, timeoutMs });
}

/** Every SWE-bench Lite instance, as downloaded. */
export function loadInstances(): SweItem[] {
  return JSON.parse(readFileSync(resolve('benchmarks/data/swebench-lite.json'), 'utf8')) as SweItem[];
}

/**
 * The checker, as a Python program read from stdin.
 *
 * It is the SWE-bench criterion made into an exit code. The test patch is
 * embedded in it and applied from memory (`git apply -`), so the check needs
 * no file of its own in the container, and it cleans up after itself: the
 * hidden tests are present only while they run. For pytest-driven repositories
 * this is the exact program every earlier run used (pinned by a test); Django
 * instances get the same program around Django's own test runner.
 */
export function checkerSource(item: SweItem): string {
  if (isDjango(item)) return testProgram(item, { judge: 'all', after: 'base' });
  const files = patchedFiles(item.test_patch);
  const cmd = `PYTHONDONTWRITEBYTECODE=1 python -m pytest -rA --tb=short -p no:cacheprovider ${files.map(f => shQuote(f)).join(' ')}`;
  return [
    'import re, subprocess, sys',
    `BASE = ${JSON.stringify(item.base_commit)}`,
    `FILES = ${JSON.stringify(files)}`,
    `F2P = ${JSON.stringify(JSON.parse(item.FAIL_TO_PASS) as string[])}`,
    `P2P = ${JSON.stringify(JSON.parse(item.PASS_TO_PASS) as string[])}`,
    `PATCH = ${JSON.stringify(item.test_patch)}`,
    `BYTECODE_CLEANUP = ${JSON.stringify(bytecodeCleanup(files))}`,
    '',
    'def q(s):',
    '    return "\'" + s.replace("\'", "\'\\\\\'\'") + "\'"',
    '',
    'def sh(c, data=None, **kw):',
    '    io = {"input": data} if data is not None else {"stdin": subprocess.DEVNULL}',
    '    return subprocess.run(["bash", "-lc", c], capture_output=True, encoding="utf-8", errors="replace", cwd="/testbed", **io, **kw)',
    '',
    'def restore():',
    '    # Each hidden-test file back to the base commit; one the patch added is removed.',
    '    for f in FILES:',
    '        if sh("git cat-file -e %s" % q(BASE + ":" + f)).returncode == 0:',
    '            sh("git checkout -q %s -- %s" % (BASE, q(f)))',
    '        else:',
    '            sh("rm -f -- %s" % q(f))',
    '    if BYTECODE_CLEANUP:',
    '        sh(BYTECODE_CLEANUP)',
    '',
    '# Lay the hidden tests over whatever the agent has done.',
    'restore()',
    'applied = sh("git apply --whitespace=nowarn -", data=PATCH)',
    'if applied.returncode != 0:',
    '    restore()',
    '    print("VERIFY: test patch did not apply"); sys.exit(2)',
    '',
    'try:',
    `    run = sh(${JSON.stringify(`source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; ${cmd} 2>&1`)}, timeout=900)`,
    '    log = run.stdout + run.stderr',
    'except subprocess.TimeoutExpired:',
    '    log = "VERIFY: the tests timed out"',
    'restore()',
    '',
    'status = {}',
    'for line in log.splitlines():',
    '    m = re.match(r"^(PASSED|FAILED|ERROR)\\s+(\\S+)", line.strip())',
    '    if m:',
    '        status[m.group(2)] = m.group(1) == "PASSED"',
    '',
    'f2p_bad = [t for t in F2P if status.get(t) is not True]',
    'p2p_bad = [t for t in P2P if status.get(t) is not True]',
    'print("VERIFY: F2P %d/%d, P2P %d/%d" % (len(F2P) - len(f2p_bad), len(F2P), len(P2P) - len(p2p_bad), len(P2P)))',
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

function ensureContainer(item: SweItem, slot: string, docker: DockerRun): string {
  const name = containerFor(item.instance_id, slot);
  const running = docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (!(running.status === 0 && running.stdout.trim() === 'true')) {
    if (docker(['inspect', '-f', '{{.Id}}', name]).status === 0) docker(['start', name]);
    else {
      const r = docker(['run', '-d', '--name', name, '-w', '/testbed', imageFor(item.instance_id), 'sleep', 'infinity']);
      if (r.status !== 0) throw new Error(`docker run failed for ${item.instance_id}: ${r.stderr.trim().slice(0, 200)}`);
    }
  }
  inRepo(name, 'git config --global --add safe.directory /testbed; git config core.fileMode false', 60_000, undefined, docker);
  return name;
}

/** Back to the base commit, so no arm ever inherits another's edits. */
function resetRepo(container: string, item: SweItem, docker: DockerRun): void {
  const r = inRepo(container, `git checkout -q ${item.base_commit} -- . && git checkout -q -- . && git clean -fdq`, 120_000, undefined, docker);
  if (r.status !== 0) throw new Error(`git reset failed: ${r.stderr.trim().slice(0, 200)}`);
}

/** Remove anything an earlier check left in a reused container. */
function scrubContainer(container: string, item: SweItem, docker: DockerRun): void {
  const cleanup = [`rm -f ${LEGACY_CONTAINER_FILES.join(' ')}`, bytecodeCleanup(patchedFiles(item.test_patch))].filter(Boolean).join('; ');
  const r = inRepo(container, cleanup, 60_000, undefined, docker);
  if (r.status !== 0) throw new Error(`could not clear old checker files: ${r.stderr.trim().slice(0, 200)}`);
}

/** The checker and the test patch, written on the host only. Returns the checker's path. */
function install(item: SweItem, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const checkPath = join(dir, 'check.py');
  // The patch is kept beside the checker for inspection; the checker embeds its own copy.
  writeFileSync(join(dir, 'test.patch'), item.test_patch);
  writeFileSync(checkPath, checkerSource(item));
  return checkPath;
}

/** Pipe the host-side checker into the container and run it there. */
export function runCheck(container: string, checkerPath: string, docker: DockerRun = realDocker): DockerResult {
  return inRepo(container, 'python -', 960_000, readFileSync(checkerPath, 'utf8'), docker);
}

/**
 * The command the runtime's verifier and gate both run, on the host.
 *
 * It starts `run-check.ts`, which reads the checker from the host and pipes it
 * into the container: nothing has to exist in the container for it to work.
 * Node and tsx are already what runs this harness.
 */
export function verifyCommand(container: string, checkerPath: string): string {
  const tsx = resolve('node_modules/tsx/dist/cli.mjs');
  const script = resolve('benchmarks/real-repo/run-check.ts');
  return `node "${tsx}" "${script}" "${container}" "${checkerPath}"`;
}

const truncate = (s: string, cap: number): string =>
  s.length <= cap ? s : `${s.slice(0, Math.floor(cap * 0.6))}\n... [${s.length - cap} chars omitted] ...\n${s.slice(-Math.floor(cap * 0.4))}`;

/**
 * The hidden SWE-bench score for the repository as it stands.
 *
 * Runs the scoring program (hidden test patch, FAIL_TO_PASS and PASS_TO_PASS)
 * and leaves the repository exactly as it found it, so scoring mid-run cannot
 * change the run. Its result is for the record only: no agent is shown it.
 * The program is written to `dir` on the host (default: the scoring area under
 * ARTIFACT_ROOT) and piped in like every other check.
 */
export function scoreHidden(container: string, item: SweItem, opts: { docker?: DockerRun; dir?: string } = {}): HiddenScore {
  const dir = opts.dir ?? join(ARTIFACT_ROOT, 'scoring', item.instance_id);
  mkdirSync(dir, { recursive: true });
  const scorer = join(dir, 'score.py');
  writeFileSync(scorer, hiddenScorerSource(item));
  const r = runCheck(container, scorer, opts.docker ?? realDocker);
  return parseScore(r.status, `${r.stdout}${r.stderr}`);
}

/** A reproduction test to check against, as stored on the host by `repro-gen`. */
export interface ReproCheck {
  source: string;
  /** Whether `repro-fidelity` found it failing at the base commit and passing with the gold patch */
  faithful: boolean;
}

export interface PrepareOptions {
  /** Defaults to the real `docker` CLI */
  docker?: DockerRun;
  /** Where host-side checker files go; defaults to ARTIFACT_ROOT */
  root?: string;
  /** What the gate and the escalation verifier run; defaults to `oracle` (the hidden tests) */
  mode?: CheckMode;
  /** Required with mode `repro` */
  repro?: ReproCheck;
}

/** The repo-level fields a real-repo run adds to its record. */
export interface RealRepoRunRecord {
  checkMode: CheckMode;
  /** repro mode: whether the reproduction test was found faithful */
  checkFaithful?: boolean;
  /** The hidden SWE-bench score of the final repository state (never shown to an agent) */
  hidden: HiddenScore;
  /** Outside oracle mode: whether the check itself passes on the final state */
  checkFinalPassed?: boolean;
  /** Staged arms outside oracle mode: the hidden score after stage 1, before any recovery stage ran */
  stage1Hidden?: HiddenScore;
}

export type PreparedInstance = PreparedTask & {
  container: string;
  mode: CheckMode;
  /** repro mode: whether the reproduction test is faithful */
  checkFaithful?: boolean;
  /** Run the check once on the repository as it stands */
  check(): { passed: boolean; output: string };
};

/** How many failing test names the visible-f2p task text lists before summarising. */
const MAX_LISTED_TESTS = 30;

function describeInstance(item: SweItem, mode: CheckMode): string {
  const lines = [
    `Repository: ${item.repo} (a working copy is checked out at /testbed inside this environment)`,
    '',
    'Reported issue:',
    truncate(item.problem_statement, ISSUE_CAP),
    '',
    'Fix the repository so the issue is resolved. Use repo_read to read files, repo_write to change them,',
    'and repo_shell to run commands (for example to search the tree or run tests). Paths are relative to /testbed.',
    'Change the source, not the tests.',
  ];
  // Django needs its own runner; the pytest-driven pool's text is unchanged.
  if (isDjango(item)) lines.push(testHint(item));
  if (mode === 'visible-f2p') {
    const f2p = JSON.parse(item.FAIL_TO_PASS) as string[];
    lines.push(
      '',
      'These tests fail now and must pass once the issue is fixed. They are already in the repository; do not change them:',
      ...f2p.slice(0, MAX_LISTED_TESTS).map(t => `- ${t}`),
      ...(f2p.length > MAX_LISTED_TESTS ? [`- … and ${f2p.length - MAX_LISTED_TESTS} more`] : []),
      `They are in: ${patchedFiles(item.test_patch).join(', ')}`,
    );
    if (!isDjango(item)) lines.push(testHint(item));
  }
  return lines.join('\n');
}

/**
 * One instance, laid out and ready to run.
 *
 * The description is the issue as reported, plus how to work in this
 * repository. It says nothing about which files are involved: locating that is
 * the task. In `oracle` mode everything an agent sees or runs is what every
 * earlier real-repository run had.
 */
export function prepareInstance(item: SweItem, slot: string, opts: PrepareOptions = {}): PreparedInstance {
  const docker = opts.docker ?? realDocker;
  const mode = opts.mode ?? 'oracle';
  if (mode === 'repro' && !opts.repro) throw new Error(`check mode repro needs a reproduction test for ${item.instance_id}`);
  const container = ensureContainer(item, slot, docker);
  resetRepo(container, item, docker);
  scrubContainer(container, item, docker);
  activeContainer = container;
  const dir = join(opts.root ?? ARTIFACT_ROOT, slot, item.instance_id);
  // check.py is the hidden checker in every mode; in oracle mode it is also the check.
  const hiddenChecker = install(item, dir);

  let checkPath = hiddenChecker;
  if (mode === 'visible-f2p') {
    checkPath = join(dir, 'check-visible-f2p.py');
    writeFileSync(checkPath, visibleF2pSource(item));
    // Visible from the start: the failing tests are part of the repository.
    const applied = inRepo(container, 'git apply --whitespace=nowarn -', 60_000, item.test_patch, docker);
    if (applied.status !== 0) throw new Error(`could not apply the visible tests for ${item.instance_id}: ${applied.stderr.trim().slice(0, 200)}`);
  } else if (mode === 'repro') {
    checkPath = join(dir, 'check-repro.py');
    writeFileSync(checkPath, reproCheckSource(item, opts.repro!.source, { existing: true }));
  }

  const scoring = { docker, dir };
  const check = (): { passed: boolean; output: string } => {
    const r = runCheck(container, checkPath, docker);
    return { passed: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
  };

  // Outside oracle mode the hidden score is measured after every staged
  // stage, for the record only; oracle runs stay exactly as they were.
  const stageScores: Array<{ stage: number; hidden: HiddenScore }> = [];
  const observeStage = mode === 'oracle'
    ? undefined
    : ({ stage }: { stage: number }) => {
      const hidden = scoreHidden(container, item, scoring);
      stageScores.push({ stage, hidden });
      return { hidden };
    };

  return {
    container,
    dir,
    mode,
    ...(mode === 'repro' ? { checkFaithful: opts.repro!.faithful } : {}),
    description: describeInstance(item, mode),
    // The runtime's per-stage verifier and the gate both run this on the host.
    verifyCommand: verifyCommand(container, checkPath),
    verifyLabel: CHECK_LABELS[mode],
    // The agents' writes land in the container, so the gate snapshots and
    // restores there: a regression after a passing check is undone in /testbed.
    workspace: containerWorkspace((command, timeoutMs, input) => inRepo(container, command, timeoutMs, input, docker)),
    ...(observeStage ? { observeStage } : {}),
    check,
    verify: () => {
      if (mode === 'oracle') {
        const r = runCheck(container, hiddenChecker, docker);
        const out = `${r.stdout}${r.stderr}`.trim();
        const record: RealRepoRunRecord = { checkMode: mode, hidden: parseScore(r.status, out) };
        return { success: r.status === 0, output: out.slice(-600), record };
      }
      // Success is the hidden score; the check's own verdict is kept beside it.
      const hidden = scoreHidden(container, item, scoring);
      const final = check();
      const stage1 = stageScores.find(s => s.stage === 1);
      const record: RealRepoRunRecord = {
        checkMode: mode,
        ...(mode === 'repro' ? { checkFaithful: opts.repro!.faithful } : {}),
        hidden,
        checkFinalPassed: final.passed,
        ...(stage1 ? { stage1Hidden: stage1.hidden } : {}),
      };
      const detail = `hidden: F2P ${hidden.f2pPassed}/${hidden.f2pTotal}, P2P failing ${hidden.p2pFailed}/${hidden.p2pTotal}${hidden.error ? ` (${hidden.error})` : ''}; check ${final.passed ? 'passes' : 'fails'}`;
      return { success: hidden.resolved, output: detail, record };
    },
  };
}

/**
 * The repository's changes since the base commit, as a binary diff that
 * `restoreBranch` can replay. Untracked files are included (added to the index
 * first); ignored files are not.
 */
export function captureDiff(container: string, item: SweItem, docker: DockerRun = realDocker): string {
  const r = inRepo(container, `git add -A && git diff --cached --binary ${item.base_commit}`, 120_000, undefined, docker);
  if (r.status !== 0) throw new Error(`could not capture the diff: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

/** Back to the base commit, then the given diff on top: a branch point, replayed. */
export function restoreBranch(container: string, item: SweItem, diff: string, docker: DockerRun = realDocker): void {
  resetRepo(container, item, docker);
  if (diff.trim().length === 0) return;
  const r = inRepo(container, 'git apply --binary --whitespace=nowarn -', 120_000, diff, docker);
  if (r.status !== 0) throw new Error(`could not replay the branch diff: ${r.stderr.trim().slice(0, 200)}`);
}

export interface WorkloadOptions {
  mode?: CheckMode;
  /** Reproduction tests by instance id; required for every item in repro mode */
  repro?: ReadonlyMap<string, ReproCheck>;
}

/** SWE instances as workloads the existing comparison runner can execute. */
export function sweWorkloads(items: readonly SweItem[], slot: string, opts: WorkloadOptions = {}): ScalingWorkload[] {
  return items.map(item => ({
    workloadId: item.instance_id,
    prepare: () => prepareInstance(item, slot, {
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.repro?.has(item.instance_id) ? { repro: opts.repro.get(item.instance_id)! } : {}),
    }),
  }));
}
