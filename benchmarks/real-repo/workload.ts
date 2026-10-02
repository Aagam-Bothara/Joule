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
 * Scope: pytest-driven repositories (pytest, pylint, flask). One log format,
 * one parser, and suites that finish in seconds rather than the minutes django
 * and sympy need — which is what makes a per-stage verifier affordable at all.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PreparedTask } from '../crew-scaling/tasks.js';
import type { ScalingWorkload } from '../crew-scaling/runner.js';
import { containerWorkspace } from '../harness/workloads/repo-workspace.js';

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

const patchedFiles = (patch: string): string[] =>
  [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map(m => m[2]);

const shQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Bytecode pytest may have left for the hidden test files: compiled hidden
 * tests are hidden tests. Checks no longer write it; this removes what older
 * checks left in a reused container.
 */
function bytecodeCleanup(files: readonly string[]): string {
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

/**
 * The checker, as a Python program read from stdin.
 *
 * It is the SWE-bench criterion made into an exit code. The test patch is
 * embedded in it and applied from memory (`git apply -`), so the check needs
 * no file of its own in the container, and it cleans up after itself: the
 * hidden tests are present only while they run.
 */
export function checkerSource(item: SweItem): string {
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

export interface PrepareOptions {
  /** Defaults to the real `docker` CLI */
  docker?: DockerRun;
  /** Where host-side checker files go; defaults to ARTIFACT_ROOT */
  root?: string;
}

/**
 * One instance, laid out and ready to run.
 *
 * The description is the issue as reported, plus how to work in this
 * repository. It says nothing about which files are involved: locating that is
 * the task.
 */
export function prepareInstance(item: SweItem, slot: string, opts: PrepareOptions = {}): PreparedTask & { container: string } {
  const docker = opts.docker ?? realDocker;
  const container = ensureContainer(item, slot, docker);
  resetRepo(container, item, docker);
  scrubContainer(container, item, docker);
  activeContainer = container;
  const dir = join(opts.root ?? ARTIFACT_ROOT, slot, item.instance_id);
  const checker = install(item, dir);

  const description = [
    `Repository: ${item.repo} (a working copy is checked out at /testbed inside this environment)`,
    '',
    'Reported issue:',
    truncate(item.problem_statement, ISSUE_CAP),
    '',
    'Fix the repository so the issue is resolved. Use repo_read to read files, repo_write to change them,',
    'and repo_shell to run commands (for example to search the tree or run tests). Paths are relative to /testbed.',
    'Change the source, not the tests.',
  ].join('\n');

  return {
    container,
    dir,
    description,
    // The runtime's per-stage verifier and the gate both run this on the host.
    verifyCommand: verifyCommand(container, checker),
    verifyLabel: CHECK_LABEL,
    // The agents' writes land in the container, so the gate snapshots and
    // restores there: a regression after a passing check is undone in /testbed.
    workspace: containerWorkspace((command, timeoutMs, input) => inRepo(container, command, timeoutMs, input, docker)),
    verify: () => {
      const r = runCheck(container, checker, docker);
      const out = `${r.stdout}${r.stderr}`.trim();
      return { success: r.status === 0, output: out.slice(-600) };
    },
  };
}

/** SWE instances as workloads the existing comparison runner can execute. */
export function sweWorkloads(items: readonly SweItem[], slot: string): ScalingWorkload[] {
  return items.map(item => ({
    workloadId: item.instance_id,
    prepare: () => prepareInstance(item, slot),
  }));
}
