/**
 * Real-repository validation CLI.
 *
 *   npx tsx benchmarks/real-repo/cli.ts pool [--held-out]
 *   npx tsx benchmarks/real-repo/cli.ts run --arms full_verify,staged [--check oracle|repro|visible-f2p] [--pool dev|held-out]
 *   npx tsx benchmarks/real-repo/cli.ts repro-gen --repro-dir <dir> [--pool dev|held-out] [--retry-missing]
 *   npx tsx benchmarks/real-repo/cli.ts repro-fidelity --repro-dir <dir>
 *   npx tsx benchmarks/real-repo/cli.ts branch --check <mode> [--controls R,C0,C1] [--seeds n]
 *   npx tsx benchmarks/real-repo/cli.ts analyze [--arms ...]
 *   npx tsx benchmarks/real-repo/cli.ts analyze-branch
 *
 * The task pools are decided by `benchmarks/real-repo/selftest.ts` before any
 * run and are not revisited afterwards. `pool`, `repro-fidelity`, `analyze`
 * and `analyze-branch` call no model; `run`, `repro-gen` and `branch` do.
 *
 * Check modes (checks.ts): `oracle` is every earlier run's setting — the
 * hidden SWE-bench tests are the check. `repro` and `visible-f2p` use a check a
 * user could have; there the hidden tests only score the final state (and, in
 * staged arms, each stage) and are never shown to an agent.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { recoveryTask, runVerification, stageEvidence } from '@joule/core';
import { parseJsonl } from '../lifecycle/record.js';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import { runCrewScaling, startRuntime } from '../crew-scaling/runner.js';
import { type ComparisonArm } from '../specialist-value/crews.js';
import { REPRO_AUTHOR, SWE_AGENTS, singleAgentCrew, sweCrew } from './crews.js';
import { observedRepoTools } from './record.js';
import { compareStaged, renderStagedComparison } from '../specialist-value/staged-analyze.js';
import { repoTools } from '../harness/workloads/swebench.js';
import { containerWorkspace } from '../harness/workloads/repo-workspace.js';
import { manifestBilling } from '../crew-scaling/record.js';
import { CHECK_DESCRIPTIONS, CHECK_LABELS, CHECK_MODES, type CheckMode } from './checks.js';
import { CONTROL_DESCRIPTIONS, parseControls, runBranchPoint, type BranchRecord } from './branch.js';
import {
  DEV_SELFTEST,
  HELD_OUT_DIR,
  HELD_OUT_SIZE,
  devPoolIds,
  evaluateG1,
  evaluateG2,
  heldOutPoolIds,
  reproFallback,
  selectReproItems,
  type SelftestRow,
} from './prereg.js';
import {
  REPRO_PROMPT_VERSION,
  checkFidelity,
  generateRepros,
  loadReproChecks,
  readStoredRepros,
  renderFidelity,
  reproTaskDescription,
  type ReproRecord,
} from './repro.js';
import {
  ARTIFACT_ROOT,
  CHECK_LABEL,
  captureDiff,
  currentContainer,
  inRepo,
  loadInstances,
  prepareInstance,
  restoreBranch,
  runCheck,
  scoreHidden,
  sweWorkloads,
  type ReproCheck,
  type SweItem,
} from './workload.js';

const DEFAULT_DIR = join('benchmarks', 'experiments', 'real-repo-validation');
const TOOLS_NOTE = 'repo_read, repo_write, repo_edit, repo_shell (container-side; the authored fixtures used host file/shell tools)';
const HIDDEN_SCORING = 'hidden SWE-bench criterion (instance test patch over the final state, FAIL_TO_PASS and PASS_TO_PASS) run by a separate host-side program that restores the repository exactly afterwards; recorded as `hidden`, never shown to an agent outside oracle mode';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const gitCommit = (): string => {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; }
};
const treeDirty = (): boolean => {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8' })
      .split('\n').some(l => l.trim().length > 0 && !l.includes('?? '));
  } catch { return false; }
};

const readRows = (file: string): SelftestRow[] => {
  if (!existsSync(file)) throw new Error(`run the self-test first: no ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as SelftestRow[];
};

const byIds = (ids: readonly string[]): SweItem[] => {
  const byId = new Map(loadInstances().map(i => [i.instance_id, i]));
  return ids.map(id => byId.get(id)).filter((i): i is SweItem => i !== undefined);
};

/**
 * The instances the self-test admitted, in a fixed order.
 *
 * Selection is the self-test's verdict and nothing else: it ran before any
 * model did, and it never saw a Joule result.
 */
export function taskPool(limit?: number): SweItem[] {
  const items = byIds(devPoolIds(readRows(join(DEFAULT_DIR, 'selftest.json'))));
  return limit !== undefined ? items.slice(0, limit) : items;
}

/** The held-out pool, as fixed by `pool --held-out`. */
function heldOutPool(): SweItem[] {
  const file = join(HELD_OUT_DIR, 'pool.json');
  if (!existsSync(file)) throw new Error(`no ${file}: run "cli.ts pool --held-out" first`);
  return byIds((JSON.parse(readFileSync(file, 'utf8')) as { ids: string[] }).ids);
}

function pickItems(): { pool: string; items: SweItem[]; selectionRule: string } {
  const pool = arg('--pool') ?? 'dev';
  const limit = arg('--tasks') ? Number(arg('--tasks')) : undefined;
  const only = arg('--instances')?.split(',').map(s => s.trim()).filter(Boolean);
  let items = pool === 'held-out' ? heldOutPool() : taskPool();
  if (limit !== undefined) items = items.slice(0, limit);
  if (only) items = items.filter(i => only.includes(i.instance_id));
  const selectionRule = pool === 'held-out'
    ? `held-out: the first ${HELD_OUT_SIZE} self-test-usable Django instances in instance-id order (only images already local; none pulled), excluding the development ids`
    : 'image present locally AND repo is pytest-driven (pytest/pylint/flask) AND self-test passes (fails at base commit, passes with the upstream fix)';
  return { pool, items, selectionRule };
}

function parseMode(): CheckMode {
  const mode = (arg('--check') ?? 'oracle') as CheckMode;
  if (!CHECK_MODES.includes(mode)) throw new Error(`unknown --check ${mode}; expected one of ${CHECK_MODES.join(', ')}`);
  return mode;
}

/** Items and reproduction tests a run in `mode` may use. */
function forMode(mode: CheckMode, items: SweItem[]): { items: SweItem[]; repro?: Map<string, ReproCheck>; skipped: Array<{ instanceId: string; reason: string }> } {
  if (mode !== 'repro') return { items, skipped: [] };
  const dir = arg('--repro-dir');
  if (!dir) throw new Error('--check repro needs --repro-dir (written by repro-gen and repro-fidelity)');
  const repro = loadReproChecks(dir);
  const picked = selectReproItems(items, repro, process.argv.includes('--allow-unfaithful'));
  for (const s of picked.skipped) process.stderr.write(`  skipping ${s.instanceId}: ${s.reason}\n`);
  return { items: picked.items, repro, skipped: picked.skipped };
}

function modeManifest(mode: CheckMode, repro: Map<string, ReproCheck> | undefined, skipped: Array<{ instanceId: string; reason: string }>) {
  return {
    checkMode: mode,
    ...(mode === 'oracle' ? { oracle: true } : {}),
    checkDescription: CHECK_DESCRIPTIONS[mode],
    checkLabel: CHECK_LABELS[mode],
    hiddenScoring: HIDDEN_SCORING,
    ...(mode === 'oracle' ? {} : { stageScoring: 'staged arms: hidden score after every executed stage, stored as staged.stages[].observation.hidden; stage 1 also as stage1Hidden' }),
    ...(repro ? {
      reproDir: arg('--repro-dir'),
      reproPromptVersion: REPRO_PROMPT_VERSION,
      reproFaithful: Object.fromEntries([...repro].map(([id, r]) => [id, r.faithful])),
      allowUnfaithful: process.argv.includes('--allow-unfaithful'),
    } : {}),
    skipped,
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'pool';
  const outDir = arg('--out-dir') ?? DEFAULT_DIR;
  const model = arg('--model') ?? 'deepseek/deepseek-v4-flash';
  const provider = arg('--provider') ?? 'openrouter';

  if (command === 'pool') {
    if (process.argv.includes('--held-out')) {
      const rows = readRows(join(HELD_OUT_DIR, 'selftest.json'));
      const devIds = devPoolIds(readRows(DEV_SELFTEST));
      const ids = heldOutPoolIds(rows, devIds);
      const pool = {
        rule: `first ${HELD_OUT_SIZE} self-test-usable django__django instances in instance-id order, excluding the ${devIds.length} development ids; only images already local were self-tested`,
        selftestedCandidates: rows.length,
        usable: rows.filter(r => r.usable).length,
        size: ids.length,
        ids,
      };
      writeFileSync(join(HELD_OUT_DIR, 'pool.json'), JSON.stringify(pool, null, 2));
      process.stdout.write(`${ids.length} held-out task(s) (${pool.usable} usable of ${rows.length} self-tested)\n`);
      for (const id of ids) process.stdout.write(`  ${id}\n`);
      return;
    }
    const items = taskPool();
    process.stdout.write(`${items.length} task(s) in the pool\n`);
    for (const i of items) process.stdout.write(`  ${i.instance_id.padEnd(28)} ${i.repo}\n`);
    return;
  }

  if (command === 'run') {
    const arms = (arg('--arms') ?? 'full_verify,staged').split(',').map(s => s.trim()).filter(Boolean) as ComparisonArm[];
    const seeds = Number(arg('--seeds', '1'));
    const mode = parseMode();
    const picked = pickItems();
    const { items, repro, skipped } = forMode(mode, picked.items);

    process.stderr.write(`${items.length * arms.length * seeds} run(s): ${items.length} real issue(s) x ${arms.length} arm(s) x ${seeds} rep(s), ${model}, check ${mode}\n`);
    const started = new Date().toISOString();
    const results: Array<{ arm: string; records: CrewScalingRecord[] }> = [];

    for (const arm of arms) {
      process.stderr.write(`\n--- arm ${arm} ---\n`);
      const records = await runCrewScaling({
        // A container per (instance, arm): no arm can inherit another's edits.
        workloads: sweWorkloads(items, arm, mode === 'oracle' ? {} : { mode, ...(repro ? { repro } : {}) }),
        crewFactory: () => sweCrew(arm),
        tools: repoTools(currentContainer, join(ARTIFACT_ROOT, arm, 'shadow')),
        widths: [1],
        tasks: items.length,
        offset: 0,
        seeds,
        verifiedEdit: true,
        provider,
        model,
        outDir: join(outDir, arm),
        label: `real-repo-${arm}`,
      });
      results.push({ arm, records });
    }

    mkdirSync(outDir, { recursive: true });
    const observedTools = observedRepoTools(results.flatMap(r => r.records));
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
      startedAt: started,
      finishedAt: new Date().toISOString(),
      runtimeCommit: gitCommit(),
      runtimeDirty: treeDirty(),
      responseParser: 'array-xml-bare-alias-v1',
      toolOutputPolicy: 'repo_read 16000 chars, repo_shell 10000 chars, other tools 1000 chars',
      containerPythonEditGuard: 'repo_write/repo_edit compile .py and .pyi after writing; restore previous content or remove a new file on failure',
      costAccounting: 'totalCostUsd is Joule\'s budget estimate from total tokens and the local model price table; billing.totalBilledCostUsd is what the provider reported it billed (OpenRouter usage.cost), covering billing.billedModelCalls of billing.modelCalls; billing.modelHosts counts calls per upstream host OpenRouter reported (recorded, not pinned)',
      benchmark: 'SWE-bench Lite (princeton-nlp/SWE-bench_Lite, test split)',
      pool: picked.pool,
      selectionRule: picked.selectionRule,
      model, provider, arms,
      taskIds: items.map(i => i.instance_id),
      repositories: [...new Set(items.map(i => i.repo))],
      repetitions: seeds,
      budgetMode: sweCrew('staged').budgetMode,
      perAgentBudget: sweCrew('staged').budget,
      ...modeManifest(mode, repro, skipped),
      verificationPolicy: mode === 'oracle'
        ? 'SWE-bench criterion in-container: hidden test patch applied over the agent\'s work, FAIL_TO_PASS and PASS_TO_PASS must all pass, test files restored to the base commit (files the patch added removed) afterwards, tests run with PYTHONDONTWRITEBYTECODE=1'
        : CHECK_DESCRIPTIONS[mode],
      checkerPlacement: 'every check and scoring program kept on the host under the artifact directory and piped into the container on stdin (benchmarks/real-repo/run-check.ts); nothing of it is written in the container except, during a repro check, the reproduction test itself, removed before the check returns; /tmp/test.patch and /tmp/check.py left by older runs, and hidden-test bytecode, are removed when an instance is prepared',
      checkFeedback: `agents are told the check by name ("${mode === 'oracle' ? CHECK_LABEL : CHECK_LABELS[mode]}"), never its command; its output is shown unchanged: last 400 chars in gate messages, up to 1200 chars in the staged-recovery handoff`,
      verifiedEditGate: 'enabled, on the same check as escalation; snapshots and restores container-side files (repo_write/repo_edit paths under /testbed, read and written via docker exec) and rolls back an edit that turns a passing check into a failing one; a restore that fails is reported to the agent as not restored and counted as restoreFailedWrites, never as a rollback',
      toolArgumentRecording: 'agentResults[].tools[].args: call arguments as JSON, secrets redacted, truncated to 300 chars',
      tools: TOOLS_NOTE,
      observedTools,
      toolLoopSemantics: 'identical-call repeat blocked (tool + arguments); no tool is ever disabled',
      runs: results.reduce((n, r) => n + r.records.length, 0),
      totalCostUsd: results.reduce((s, r) => s + r.records.reduce((x, y) => x + (y.totalCostUsd ?? 0), 0), 0),
      billing: manifestBilling(results.flatMap(r => r.records)),
    }, null, 2));

    const spend = results.reduce((s, r) => s + r.records.reduce((x, y) => x + (y.totalCostUsd ?? 0), 0), 0);
    process.stderr.write(`\n${results.reduce((n, r) => n + r.records.length, 0)} run(s), $${spend.toFixed(4)} estimated, ${observedTools.writeAttempts} observed write attempt(s), ${observedTools.unidentifiedCalls} unidentified call(s), written under ${outDir}\n`);
    return;
  }

  if (command === 'repro-gen') {
    const { pool, items: poolItems } = pickItems();
    const dir = arg('--repro-dir') ?? join(outDir, 'repro');
    // --retry-missing: run the author again only for issues whose earlier pass
    // stored no test, keeping every earlier record as it was.
    const retry = process.argv.includes('--retry-missing');
    const earlier: ReproRecord[] = retry && existsSync(join(dir, 'repro.jsonl'))
      ? parseJsonl<ReproRecord>(readFileSync(join(dir, 'repro.jsonl'), 'utf8'))
      : [];
    if (retry && earlier.length === 0) throw new Error(`--retry-missing needs an earlier pass in ${dir}`);
    const storedIds = new Set(earlier.filter(r => r.stored).map(r => r.instanceId));
    const items = retry ? poolItems.filter(i => !storedIds.has(i.instance_id)) : poolItems;
    const attempt = retry ? Math.max(1, ...earlier.map(r => r.attempt ?? 1)) + 1 : undefined;
    // Every earlier record stays, failed ones included, so repro.jsonl is the
    // full history of attempts (cost and why each ended). Runs read the stored
    // .py files, not this log.
    const keep = retry ? earlier : [];
    if (retry) process.stderr.write(`retrying ${items.length} issue(s) with no stored test (attempt ${attempt})\n`);
    const joule = await startRuntime(provider, model, repoTools(currentContainer, join(ARTIFACT_ROOT, 'repro', 'shadow')));
    const started = new Date().toISOString();
    try {
      const records = await generateRepros(items, dir, REPRO_AUTHOR, {
        prepare: item => prepareInstance(item, 'repro'),
        runAgent: (agent, task) => joule.executeCrew(singleAgentCrew(agent, 'rr-repro-author'), task),
        readFile: (container, path) => containerWorkspace((c, t, i) => inRepo(container, c, t, i)).read(path),
        reset: (container, item) => restoreBranch(container, item, ''),
      }, line => process.stderr.write(`${line}\n`), { keep, ...(attempt !== undefined ? { attempt } : {}) });
      writeFileSync(join(dir, retry ? `manifest-attempt-${attempt}.json` : 'manifest.json'), JSON.stringify({
        ...(retry ? { retryOf: 'issues whose earlier pass stored no test', attempt, kept: keep.length } : {}),
        startedAt: started,
        finishedAt: new Date().toISOString(),
        runtimeCommit: gitCommit(),
        runtimeDirty: treeDirty(),
        model, provider, pool,
        promptVersion: REPRO_PROMPT_VERSION,
        author: { instructions: REPRO_AUTHOR.instructions, maxIterations: REPRO_AUTHOR.maxIterations, maxOutputTokens: REPRO_AUTHOR.maxOutputTokens, wallTimeoutMs: REPRO_AUTHOR.wallTimeoutMs, budget: singleAgentCrew(REPRO_AUTHOR, 'x').budget, tools: REPRO_AUTHOR.allowedTools },
        sees: 'the issue text and the repository at its base commit; no hidden test, no check, no other agent',
        prompts: Object.fromEntries(items.map(i => [i.instance_id, reproTaskDescription(i)])),
        stored: records.filter(r => r.stored).length,
        generated: records.length,
        totalCostUsd: records.reduce((s, r) => s + (r.costUsd ?? 0), 0),
        totalBilledCostUsd: records.some(r => r.billedCostUsd !== undefined) ? records.reduce((s, r) => s + (r.billedCostUsd ?? 0), 0) : null,
        next: `npx tsx benchmarks/real-repo/cli.ts repro-fidelity --repro-dir ${dir}`,
      }, null, 2));
      process.stderr.write(`${records.filter(r => r.stored).length} of ${records.length} reproduction test(s) stored under ${dir}\n`);
    } finally {
      await joule.shutdown();
    }
    return;
  }

  if (command === 'repro-fidelity') {
    const dir = arg('--repro-dir');
    if (!dir) throw new Error('repro-fidelity needs --repro-dir');
    const stored = readStoredRepros(dir);
    const items = byIds([...stored.keys()]);
    const programs = join(ARTIFACT_ROOT, 'fidelity-programs');
    mkdirSync(programs, { recursive: true });
    const rows = checkFidelity(items, stored, {
      prepare: item => prepareInstance(item, 'fidelity'),
      runProgram: (container, source) => {
        const file = join(programs, `${container}.py`);
        writeFileSync(file, source);
        const r = runCheck(container, file);
        return { status: r.status, output: `${r.stdout}${r.stderr}` };
      },
      applyGold: (container, item) => {
        const r = inRepo(container, 'git apply --whitespace=nowarn -', 60_000, item.patch);
        return r.status === 0 ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 200) };
      },
      reset: (container, item) => restoreBranch(container, item, ''),
    });
    writeFileSync(join(dir, 'fidelity.json'), JSON.stringify(rows, null, 2));
    writeFileSync(join(dir, 'fidelity.md'), renderFidelity(rows));
    const faithful = rows.filter(r => r.faithful).length;
    process.stdout.write(renderFidelity(rows));
    process.stdout.write(`Pre-registered fallback (<= 5 faithful of the 13 dev issues -> visible-f2p): ${reproFallback(faithful) ? 'FALL BACK to visible-f2p' : 'use repro'}\n`);
    return;
  }

  if (command === 'branch') {
    const mode = parseMode();
    const controls = parseControls(arg('--controls'));
    const seeds = Number(arg('--seeds', '1'));
    const picked = pickItems();
    const { items, repro, skipped } = forMode(mode, picked.items);
    const diffs = join(outDir, 'diffs');
    mkdirSync(diffs, { recursive: true });
    const started = new Date().toISOString();
    process.stderr.write(`branch points: ${items.length} issue(s) x ${seeds} seed(s), controls ${controls.join(',')}, check ${mode}\n`);
    const joule = await startRuntime(provider, model, repoTools(currentContainer, join(ARTIFACT_ROOT, 'branch', 'shadow')));
    const records: BranchRecord[] = [];
    try {
      for (const item of items) {
        for (let seed = 0; seed < seeds; seed++) {
          const record = await runBranchPoint(item, seed, controls, { implementer: SWE_AGENTS.implementer, reviewer: SWE_AGENTS.reviewer }, {
            prepare: it => prepareInstance(it, 'branch', mode === 'oracle' ? {} : { mode, ...(repro?.has(it.instance_id) ? { repro: repro.get(it.instance_id)! } : {}) }),
            runAgent: (agent, task) => joule.executeCrew(singleAgentCrew(agent, `rr-branch-${agent.id}`), task),
            verify: policy => runVerification(policy),
            recoveryTask: (task, policy, previous, checked) => recoveryTask(task, policy, previous, stageEvidence(checked)),
            scoreHidden: (container, it) => scoreHidden(container, it),
            captureDiff: (container, it) => captureDiff(container, it),
            restoreBranch: (container, it, diff) => restoreBranch(container, it, diff),
            saveDiff: (it, s, diff) => {
              const file = join(diffs, `${it.instance_id}-s${s}.diff`);
              writeFileSync(file, diff);
              return file;
            },
          });
          records.push(record);
          writeFileSync(join(outDir, 'branches.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
          const controlNote = Object.entries(record.controls).map(([c, o]) => `${c} ${o?.hidden.resolved ? 'RESOLVED' : 'no'}`).join(', ');
          process.stderr.write(`${item.instance_id} s${seed}: stage1 check ${record.stage1.checkPassed ? 'pass' : 'fail'} hidden ${record.stage1.hidden.resolved ? 'RESOLVED' : 'no'}${record.branched ? ` -> ${controlNote}` : ' (no branch point)'}\n`);
        }
      }
    } finally {
      await joule.shutdown();
    }
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
      startedAt: started,
      finishedAt: new Date().toISOString(),
      runtimeCommit: gitCommit(),
      runtimeDirty: treeDirty(),
      model, provider,
      pool: picked.pool,
      selectionRule: picked.selectionRule,
      taskIds: items.map(i => i.instance_id),
      seeds,
      controls: Object.fromEntries(controls.map(c => [c, CONTROL_DESCRIPTIONS[c]])),
      design: 'implementer alone; when the check fails, the repository diff against the base commit is the branch point; each control replays it in a freshly reset container and runs one agent with the same allowance as in the crews',
      perAgentBudget: singleAgentCrew(SWE_AGENTS.implementer, 'x').budget,
      ...modeManifest(mode, repro, skipped),
      branchPoints: records.filter(r => r.branched).length,
      g2: evaluateG2(records),
    }, null, 2));
    process.stderr.write(`${records.filter(r => r.branched).length} branch point(s) of ${records.length} run(s), written under ${outDir}\n`);
    return;
  }

  if (command === 'analyze') {
    const arms = (arg('--arms') ?? 'full_verify,staged').split(',').map(s => s.trim()).filter(Boolean);
    const byArm = arms.flatMap(arm => {
      const file = join(outDir, arm, 'runs.jsonl');
      return existsSync(file) ? [{ arm, records: parseJsonl<CrewScalingRecord>(readFileSync(file, 'utf8')) }] : [];
    });
    if (byArm.length === 0) {
      process.stderr.write(`No records under ${outDir}\n`);
      process.exitCode = 1;
      return;
    }
    const comparison = compareStaged(byArm);
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(comparison, null, 2));
    process.stdout.write(renderStagedComparison(comparison) + '\n');
    // G1, when the staged arm carries the separate hidden score.
    const staged = byArm.find(a => a.arm === 'staged');
    if (staged && staged.records.some(r => r.stage1Hidden)) {
      const g1 = evaluateG1(staged.records);
      writeFileSync(join(outDir, 'g1.json'), JSON.stringify(g1, null, 2));
      process.stdout.write(`\nG1 (hidden): staged ${g1.stagedResolved}/${g1.runs} vs its own stage 1 ${g1.stage1Resolved}/${g1.runs}; false passes ${g1.falsePasses}/${g1.checkPasses} check passes -> ${g1.confirmed ? 'CONFIRMED' : 'not confirmed'}\n`);
    }
    return;
  }

  if (command === 'analyze-branch') {
    const file = join(outDir, 'branches.jsonl');
    if (!existsSync(file)) throw new Error(`no ${file}`);
    const g2 = evaluateG2(parseJsonl<BranchRecord>(readFileSync(file, 'utf8')));
    writeFileSync(join(outDir, 'g2.json'), JSON.stringify(g2, null, 2));
    process.stdout.write(`${JSON.stringify(g2, null, 2)}\n`);
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

export { resolve };
