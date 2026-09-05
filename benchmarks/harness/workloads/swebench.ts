/**
 * SWE-bench Lite workload: real repositories, real issues, hidden tests.
 *
 * Each instance runs in its official SWE-bench evaluation image
 * (swebench/sweb.eval.x86_64.<instance>), which has the repository checked out
 * at /testbed with the right Python environment. The agent works through
 * three tools that execute inside that container:
 *
 *   repo_shell  {command}              run a shell command in the repo
 *   repo_read   {path, start?, end?}   read a file (or a line range)
 *   repo_write  {path, content}        replace a file's content
 *
 * Success is the SWE-bench criterion: after the agent finishes, the instance's
 * test patch is applied on top of the agent's changes and the FAIL_TO_PASS and
 * PASS_TO_PASS tests must all pass. The agent never sees those tests; it sees
 * the issue text, the same as any SWE-bench submission.
 *
 * Data: benchmarks/data/swebench-lite.json (300 rows from
 * princeton-nlp/SWE-bench_Lite, test split; fetch with the datasets-server
 * rows API, offsets 0/100/200) and swebench-slice.json next to this file (the
 * instance ids used here, grouped by repo/version so images share layers;
 * sympy instances were dropped because one test file takes 15+ minutes).
 * Images: docker pull swebench/sweb.eval.x86_64.<instance_id with "__" -> "_1776_">:latest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { BUDGET_PRESETS, type ToolDefinition } from '@joule/shared';
import type { Workload } from '../types.js';

interface SweItem {
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

const DATA = resolve('benchmarks/data/swebench-lite.json');
const SLICE = resolve('benchmarks/harness/workloads/swebench-slice.json');
const LABEL = process.env.JOULE_BENCH_LABEL ?? 'default';
const SANDBOX = resolve('benchmarks/.sandbox/swebench', LABEL);
const OUTPUT_CAP = 6000;
const ISSUE_CAP = 6000;

export const imageFor = (instanceId: string): string => `swebench/sweb.eval.x86_64.${instanceId.replace('__', '_1776_')}:latest`;
const containerFor = (instanceId: string): string => `joule-swe-${LABEL}-${instanceId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

// ── docker plumbing ─────────────────────────────────────────────────

function docker(args: string[], opts: { input?: string; timeoutMs?: number } = {}): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('docker', args, { encoding: 'utf8', input: opts.input, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : ''), status: r.status ?? (r.error ? 124 : 1) };
}

/** Run a command inside the instance's conda env at /testbed. */
function inRepo(container: string, command: string, timeoutMs = 300_000, input?: string): { stdout: string; stderr: string; status: number } {
  const wrapped = `source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; cd /testbed && ${command}`;
  return docker(['exec', ...(input !== undefined ? ['-i'] : []), container, 'bash', '-c', wrapped], { input, timeoutMs });
}

function containerRunning(container: string): boolean {
  const r = docker(['inspect', '-f', '{{.State.Running}}', container]);
  return r.status === 0 && r.stdout.trim() === 'true';
}

function ensureContainer(item: SweItem): string {
  const name = containerFor(item.instance_id);
  if (containerRunning(name)) return name;
  const exists = docker(['inspect', '-f', '{{.Id}}', name]).status === 0;
  if (exists) {
    docker(['start', name]);
  } else {
    const r = docker(['run', '-d', '--name', name, '-w', '/testbed', imageFor(item.instance_id), 'sleep', 'infinity'], { timeoutMs: 300_000 });
    if (r.status !== 0) throw new Error(`docker run failed for ${item.instance_id}: ${r.stderr.trim().slice(0, 300)}`);
  }
  inRepo(name, 'git config --global --add safe.directory /testbed; git config core.fileMode false', 60_000);
  return name;
}

/** Back to the base commit's working tree (keeps the environment). */
function resetRepo(container: string, item: SweItem): void {
  const r = inRepo(container, `git checkout -q ${item.base_commit} -- . && git checkout -q -- . && git clean -fdq`, 120_000);
  if (r.status !== 0) throw new Error(`git reset failed: ${r.stderr.trim().slice(0, 300)}`);
}

function capOutput(s: string, cap = OUTPUT_CAP): string {
  if (s.length <= cap) return s;
  const head = Math.floor(cap * 0.6);
  return `${s.slice(0, head)}\n... [${s.length - cap} chars omitted] ...\n${s.slice(-(cap - head))}`;
}

// ── evaluation (SWE-bench criterion) ────────────────────────────────

const patchedFiles = (patch: string): string[] => [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)/gm)].map(m => m[2]);

function testCommand(item: SweItem): string {
  const files = patchedFiles(item.test_patch);
  if (item.repo === 'django/django') {
    const modules = files.filter(f => f.startsWith('tests/') && f.endsWith('.py')).map(f => f.slice('tests/'.length, -'.py'.length).replace(/\//g, '.').replace(/\.__init__$/, ''));
    return `./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 ${modules.join(' ')}`;
  }
  if (item.repo === 'sympy/sympy') return `bin/test -C --verbose ${files.join(' ')}`;
  return `pytest -rA --tb=short -p no:cacheprovider ${files.join(' ')}`;
}

/** Test name -> passed, parsed the way the SWE-bench harness parses each repo's log. */
export function parseTestLog(repo: string, log: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const lines = log.split(/\r?\n/);
  if (repo === 'django/django') {
    // Same rule as the SWE-bench harness: whatever precedes " ... <status>" is
    // the test's name, which for docstring tests is the docstring's first line.
    for (const raw of lines) {
      const line = raw.trim();
      const m = line.match(/^(.+?) \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$/);
      if (m) out.set(m[1], m[2] === 'ok');
    }
    return out;
  }
  if (repo === 'sympy/sympy') {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('test_')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const st = parts[1];
      if (st === 'ok') out.set(parts[0], true);
      else if (st === 'E' || st === 'F') out.set(parts[0], false);
    }
    return out;
  }
  for (const raw of lines) {
    const m = raw.match(/^(PASSED|FAILED|ERROR)\s+(\S+)/);
    if (m) out.set(m[2], m[1] === 'PASSED');
  }
  return out;
}

export interface SweEvaluation {
  success: boolean;
  f2pPassed: number;
  f2pTotal: number;
  p2pFailed: number;
  p2pTotal: number;
  modelPatchChars: number;
  detail: string;
}

/** Apply the hidden test patch on top of the agent's changes and run the instance's tests. */
export function evaluateInstance(item: SweItem, container: string, hostDir: string): SweEvaluation {
  const f2p = JSON.parse(item.FAIL_TO_PASS) as string[];
  const p2p = JSON.parse(item.PASS_TO_PASS) as string[];
  const modelPatch = inRepo(container, 'git diff', 60_000).stdout;
  try { mkdirSync(hostDir, { recursive: true }); writeFileSync(join(hostDir, 'model.patch'), modelPatch); } catch { /* best effort */ }

  const testFiles = patchedFiles(item.test_patch);
  // Restore the test files to their base state, then lay the hidden tests over the agent's work.
  inRepo(container, `git checkout -q ${item.base_commit} -- ${testFiles.map(f => `'${f}'`).join(' ')} 2>/dev/null; true`, 60_000);
  const applied = inRepo(container, 'git apply --whitespace=nowarn -', 60_000, item.test_patch);
  if (applied.status !== 0) {
    return { success: false, f2pPassed: 0, f2pTotal: f2p.length, p2pFailed: p2p.length, p2pTotal: p2p.length, modelPatchChars: modelPatch.length, detail: `test patch did not apply: ${applied.stderr.trim().slice(0, 200)}` };
  }
  const run = inRepo(container, `${testCommand(item)} 2>&1`, 900_000);
  const log = run.stdout;
  try { writeFileSync(join(hostDir, 'eval.log'), log); } catch { /* best effort */ }
  const results = parseTestLog(item.repo, log);
  const f2pPassed = f2p.filter(t => results.get(t) === true).length;
  const p2pFailed = p2p.filter(t => results.get(t) !== true).length;
  const success = f2pPassed === f2p.length && p2pFailed === 0 && f2p.length > 0;
  return {
    success, f2pPassed, f2pTotal: f2p.length, p2pFailed, p2pTotal: p2p.length, modelPatchChars: modelPatch.length,
    detail: `F2P ${f2pPassed}/${f2p.length}, P2P failing ${p2pFailed}/${p2p.length}${results.size === 0 ? ` (no test results parsed; exit ${run.status})` : ''}`,
  };
}

// ── tools ───────────────────────────────────────────────────────────

function repoTools(container: () => string, shadowDir: string): ToolDefinition[] {
  const repoShell: ToolDefinition = {
    name: 'repo_shell',
    description: 'Run a shell command inside the repository (working directory is the repository root, Python environment active). Arguments: command (string, required). Returns stdout, stderr and exitCode. Use it to search (grep -rn), run scripts (python -c "..."), and run tests (pytest path/to/test.py -x -q).',
    inputSchema: z.object({ command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(600_000).optional() }),
    outputSchema: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
    tags: ['system'],
    timeoutMs: 620_000,
    async execute(input: { command: string; timeoutMs?: number }) {
      const r = inRepo(container(), input.command, input.timeoutMs ?? 300_000);
      return { stdout: capOutput(r.stdout), stderr: capOutput(r.stderr, 2000), exitCode: r.status };
    },
  };
  const repoRead: ToolDefinition = {
    name: 'repo_read',
    description: 'Read a file from the repository. Arguments: path (string, required, relative to the repository root), start (line number, optional), end (line number, optional). Large files are truncated; pass start/end to read a specific range. Output lines are prefixed with their line number.',
    inputSchema: z.object({ path: z.string().min(1), start: z.number().int().min(1).optional(), end: z.number().int().min(1).optional() }),
    outputSchema: z.object({ content: z.string(), path: z.string(), totalLines: z.number(), truncated: z.boolean() }),
    async execute(input: { path: string; start?: number; end?: number }) {
      const c = container();
      const p = input.path.replace(/^\/testbed\//, '');
      const wc = inRepo(c, `wc -l < '${p}'`, 30_000);
      if (wc.status !== 0) throw new Error(`cannot read ${p}: ${wc.stderr.trim().slice(0, 200) || 'no such file'}`);
      const total = Number(wc.stdout.trim()) || 0;
      const start = input.start ?? 1;
      const end = input.end ?? (input.start ? input.start + 199 : total);
      const r = inRepo(c, `awk -v s=${start} -v e=${end} 'NR>=s && NR<=e { printf "%d: %s\\n", NR, $0 }' '${p}'`, 60_000);
      let content = r.stdout;
      let truncated = false;
      if (content.length > 12_000) { content = `${content.slice(0, 12_000)}\n... [truncated; read a smaller range with start/end]`; truncated = true; }
      return { content, path: p, totalLines: total, truncated };
    },
  };
  const repoWrite: ToolDefinition = {
    name: 'repo_write',
    description: 'Replace the full content of a file in the repository (creates it if missing). Arguments: path (string, required, relative to the repository root), content (string, required, the complete new file content). Read the file first and keep everything you do not intend to change.',
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    outputSchema: z.object({ path: z.string(), repoPath: z.string(), bytesWritten: z.number() }),
    async execute(input: { path: string; content: string }) {
      const c = container();
      const p = input.path.replace(/^\/testbed\//, '');
      const r = inRepo(c, `mkdir -p "$(dirname '${p}')" && cat > '${p}'`, 60_000, input.content);
      if (r.status !== 0) throw new Error(`write failed: ${r.stderr.trim().slice(0, 200)}`);
      // Host shadow copy so the executor's static check can compile it.
      const shadow = join(shadowDir, p.replace(/\//g, '/'));
      try { mkdirSync(dirname(shadow), { recursive: true }); writeFileSync(shadow, input.content); } catch { /* best effort */ }
      return { path: shadow, repoPath: p, bytesWritten: Buffer.byteLength(input.content, 'utf8') };
    },
  };
  const repoEdit: ToolDefinition = {
    name: 'repo_edit',
    description: 'Edit a file in place by replacing one exact text block. Arguments: path (string, required, relative to the repository root), search (string, required: the exact existing text, including indentation, that must occur exactly once), replace (string, required: the new text). Preferred over repo_write for any file longer than a screen.',
    inputSchema: z.object({ path: z.string().min(1), search: z.string().min(1), replace: z.string() }),
    outputSchema: z.object({ path: z.string(), repoPath: z.string(), written: z.boolean(), line: z.number() }),
    async execute(input: { path: string; search: string; replace: string }) {
      const c = container();
      const p = input.path.replace(/^\/testbed\//, '');
      const cur = inRepo(c, `cat '${p}'`, 60_000);
      if (cur.status !== 0) throw new Error(`cannot read ${p}: ${cur.stderr.trim().slice(0, 200) || 'no such file'}`);
      const text = cur.stdout;
      let i = text.indexOf(input.search);
      let search = input.search;
      if (i < 0) {
        // Tolerate trailing-whitespace drift in the search block.
        search = input.search.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
        i = text.indexOf(search);
      }
      if (i < 0) throw new Error(`search text not found in ${p}; read the file and copy the block exactly`);
      if (text.indexOf(search, i + 1) >= 0) throw new Error(`search text occurs more than once in ${p}; include more surrounding lines`);
      const next = text.slice(0, i) + input.replace + text.slice(i + search.length);
      const w = inRepo(c, `cat > '${p}'`, 60_000, next);
      if (w.status !== 0) throw new Error(`write failed: ${w.stderr.trim().slice(0, 200)}`);
      const shadow = join(shadowDir, p);
      try { mkdirSync(dirname(shadow), { recursive: true }); writeFileSync(shadow, next); } catch { /* best effort */ }
      return { path: shadow, repoPath: p, written: true, line: text.slice(0, i).split('\n').length, _content: next };
    },
  };
  return [repoShell, repoRead, repoWrite, repoEdit];
}

// ── workload ────────────────────────────────────────────────────────

/** How this repository runs its tests (what a contributor would read in its docs). */
function testHint(item: SweItem): string {
  if (item.repo === 'django/django') return 'Tests: this is the Django source tree (no manage.py, no pytest). Run a test module with: python tests/runtests.py --settings=test_sqlite --parallel 1 <module>, e.g. python tests/runtests.py --settings=test_sqlite --parallel 1 admin_views.test_adminsite (module = path under tests/ with dots).';
  if (item.repo === 'sympy/sympy') return 'Tests: run a test file with: bin/test -C sympy/path/to/tests/test_x.py';
  return 'Tests: run a test file with: pytest -x -q path/to/test_x.py';
}

function describe(item: SweItem): string {
  const issue = item.problem_statement.length > ISSUE_CAP ? `${item.problem_statement.slice(0, ISSUE_CAP)}\n... [issue truncated]` : item.problem_statement;
  return [
    `Fix the following issue in the ${item.repo} repository (Python). The repository is checked out at its root inside a container; use the repo_* tools for everything.`,
    '',
    'ISSUE:',
    issue.trim(),
    '',
    'How to work:',
    '- Locate the relevant code with repo_shell (e.g. grep -rn "def some_function" django/) and read it with repo_read (use start/end for large files; a search that prints nothing is fine, try another pattern).',
    '- Reproduce the problem with a small script (python -c "...") or an existing test.',
    '- Change the library code with repo_edit (replace one exact block; copy it from repo_read output without the line-number prefixes). Use repo_write only for new or very small files. Do not edit or add tests.',
    `- Run the relevant existing tests for the module you changed (repo_shell) and make sure they still pass, then run "git diff" to confirm the change is in place. ${testHint(item)}`,
    '- Finish with a final answer that says which file(s) you changed and why. A final answer with no file changed is not accepted. Hidden tests for this issue will be run against your change.',
  ].join('\n');
}

/**
 * `n` instances from the slice starting at `offset`. Instances whose image is
 * not present locally are skipped with a warning (pull them first).
 */
export function loadSweBench(n: number, offset = 0): Workload[] {
  if (!existsSync(DATA) || !existsSync(SLICE)) {
    throw new Error(`SWE-bench data not found (${DATA}, ${SLICE}). See benchmarks/harness/workloads/swebench.ts for how to fetch it.`);
  }
  const all = new Map((JSON.parse(readFileSync(DATA, 'utf8')) as SweItem[]).map(i => [i.instance_id, i]));
  const ids = (JSON.parse(readFileSync(SLICE, 'utf8')) as string[]).slice(offset);
  const out: Workload[] = [];
  for (const id of ids) {
    if (out.length >= n) break;
    const item = all.get(id);
    if (!item) continue;
    if (docker(['image', 'inspect', imageFor(id)]).status !== 0) {
      process.stderr.write(`  skipping ${id}: image not pulled (${imageFor(id)})\n`);
      continue;
    }
    const hostDir = join(SANDBOX, id);
    const shadow = join(hostDir, 'shadow');
    let container = containerFor(id);
    out.push({
      id,
      complexity: 'high',
      description: describe(item),
      policy: { maxSteps: 30, observationChars: 5000, maxOutputTokens: 12_000, finalAnswerRequires: 'write' },
      // Real repositories need long contexts; the cost ceiling is the real cap.
      budget: { ...BUDGET_PRESETS.high, maxTokens: 1_500_000, maxToolCalls: 40, costCeilingUsd: Number(process.env.JOULE_BENCH_SWE_CEILING ?? 0.25), maxLatencyMs: 1_800_000, maxEscalations: 3 },
      taskTools: ['repo_shell', 'repo_read', 'repo_write', 'repo_edit'],
      successIgnoresStatus: true,
      tools: () => repoTools(() => container, shadow),
      setup: () => {
        container = ensureContainer(item);
        resetRepo(container, item);
        mkdirSync(shadow, { recursive: true });
      },
      verify: result => {
        const e = evaluateInstance(item, container, hostDir);
        process.stderr.write(`      swe-bench ${id}: ${e.detail}${result.status !== 'completed' ? ` (agent status ${result.status})` : ''}\n`);
        return e.success;
      },
      answerForJudge: result => `${result.result ?? ''}\n\n[diff]\n${inRepo(container, 'git diff', 60_000).stdout.slice(0, 6000)}`,
    });
  }
  return out;
}

/** Sanity check of the evaluation pipeline: the gold patch must pass, the base must not. */
export function selfTest(instanceId: string): { base: SweEvaluation; gold: SweEvaluation } {
  const all = new Map((JSON.parse(readFileSync(DATA, 'utf8')) as SweItem[]).map(i => [i.instance_id, i]));
  const item = all.get(instanceId);
  if (!item) throw new Error(`unknown instance ${instanceId}`);
  const container = ensureContainer(item);
  const hostDir = join(SANDBOX, instanceId);
  resetRepo(container, item);
  const base = evaluateInstance(item, container, join(hostDir, 'selftest-base'));
  resetRepo(container, item);
  const applied = inRepo(container, 'git apply --whitespace=nowarn -', 60_000, item.patch);
  if (applied.status !== 0) throw new Error(`gold patch did not apply: ${applied.stderr.slice(0, 300)}`);
  const gold = evaluateInstance(item, container, join(hostDir, 'selftest-gold'));
  resetRepo(container, item);
  return { base, gold };
}
