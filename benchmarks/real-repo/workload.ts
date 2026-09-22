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
 * The verifier is a checker script placed in the container at setup. It
 * restores the test files, lays the hidden tests over the working tree, runs
 * them, parses the result, and then puts the test files back, so a check never
 * leaves the hidden tests where an agent could read them. Its exit code is the
 * whole signal: 0 only when the instance is genuinely solved.
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

function docker(args: string[], opts: { input?: string; timeoutMs?: number } = {}): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('docker', args, {
    encoding: 'utf8', input: opts.input, timeout: opts.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : ''), status: r.status ?? (r.error ? 124 : 1) };
}

/** Run a command inside the instance's conda environment at /testbed. */
export function inRepo(container: string, command: string, timeoutMs = 300_000, input?: string) {
  const wrapped = `source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; cd /testbed && ${command}`;
  return docker(['exec', ...(input !== undefined ? ['-i'] : []), container, 'bash', '-c', wrapped], { input, timeoutMs });
}

/** Every SWE-bench Lite instance, as downloaded. */
export function loadInstances(): SweItem[] {
  return JSON.parse(readFileSync(resolve('benchmarks/data/swebench-lite.json'), 'utf8')) as SweItem[];
}

const patchedFiles = (patch: string): string[] =>
  [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map(m => m[2]);

/**
 * The checker, as a Python program that lives in the container.
 *
 * It is the SWE-bench criterion made into an exit code, and it cleans up after
 * itself: the hidden tests are present only while they run.
 */
function checkerSource(item: SweItem): string {
  const files = patchedFiles(item.test_patch);
  const cmd = `python -m pytest -rA --tb=short -p no:cacheprovider ${files.map(f => `'${f}'`).join(' ')}`;
  return [
    'import json, re, subprocess, sys',
    `BASE = ${JSON.stringify(item.base_commit)}`,
    `FILES = ${JSON.stringify(files)}`,
    `F2P = ${JSON.stringify(JSON.parse(item.FAIL_TO_PASS) as string[])}`,
    `P2P = ${JSON.stringify(JSON.parse(item.PASS_TO_PASS) as string[])}`,
    '',
    'def sh(c, **kw):',
    '    return subprocess.run(["bash", "-lc", c], capture_output=True, text=True, cwd="/testbed", **kw)',
    '',
    'def restore():',
    '    sh("git checkout -q %s -- %s 2>/dev/null; true" % (BASE, " ".join("\'%s\'" % f for f in FILES)))',
    '',
    '# Lay the hidden tests over whatever the agent has done.',
    'restore()',
    'applied = sh("git apply --whitespace=nowarn /tmp/test.patch")',
    'if applied.returncode != 0:',
    '    restore()',
    '    print("VERIFY: test patch did not apply"); sys.exit(2)',
    '',
    `run = sh(${JSON.stringify(`source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; ${cmd} 2>&1`)}, timeout=900)`,
    'log = run.stdout + run.stderr',
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

function ensureContainer(item: SweItem, slot: string): string {
  const name = containerFor(item.instance_id, slot);
  const running = docker(['inspect', '-f', '{{.State.Running}}', name]);
  if (!(running.status === 0 && running.stdout.trim() === 'true')) {
    if (docker(['inspect', '-f', '{{.Id}}', name]).status === 0) docker(['start', name]);
    else {
      const r = docker(['run', '-d', '--name', name, '-w', '/testbed', imageFor(item.instance_id), 'sleep', 'infinity']);
      if (r.status !== 0) throw new Error(`docker run failed for ${item.instance_id}: ${r.stderr.trim().slice(0, 200)}`);
    }
  }
  inRepo(name, 'git config --global --add safe.directory /testbed; git config core.fileMode false', 60_000);
  return name;
}

/** Back to the base commit, so no arm ever inherits another's edits. */
function resetRepo(container: string, item: SweItem): void {
  const r = inRepo(container, `git checkout -q ${item.base_commit} -- . && git checkout -q -- . && git clean -fdq`, 120_000);
  if (r.status !== 0) throw new Error(`git reset failed: ${r.stderr.trim().slice(0, 200)}`);
}

function install(container: string, item: SweItem, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const patchPath = join(dir, 'test.patch');
  const checkPath = join(dir, 'check.py');
  writeFileSync(patchPath, item.test_patch);
  writeFileSync(checkPath, checkerSource(item));
  for (const [from, to] of [[patchPath, '/tmp/test.patch'], [checkPath, '/tmp/check.py']]) {
    const r = docker(['cp', from, `${container}:${to}`]);
    if (r.status !== 0) throw new Error(`docker cp failed: ${r.stderr.trim().slice(0, 200)}`);
  }
}

/** The command the runtime's verifier and gate both run, on the host. */
export function verifyCommand(container: string): string {
  return `docker exec ${container} bash -lc "source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; cd /testbed && python /tmp/check.py"`;
}

const truncate = (s: string, cap: number): string =>
  s.length <= cap ? s : `${s.slice(0, Math.floor(cap * 0.6))}\n... [${s.length - cap} chars omitted] ...\n${s.slice(-Math.floor(cap * 0.4))}`;

/**
 * One instance, laid out and ready to run.
 *
 * The description is the issue as reported, plus how to work in this
 * repository. It says nothing about which files are involved: locating that is
 * the task.
 */
export function prepareInstance(item: SweItem, slot: string): PreparedTask & { container: string } {
  const container = ensureContainer(item, slot);
  resetRepo(container, item);
  activeContainer = container;
  const dir = join(ARTIFACT_ROOT, slot, item.instance_id);
  install(container, item, dir);

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
    verifyCommand: verifyCommand(container),
    verify: () => {
      const r = inRepo(container, 'python /tmp/check.py', 900_000);
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
