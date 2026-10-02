/**
 * Reproduction tests: the check a user could plausibly have.
 *
 * `generateRepros` runs one agent per issue — the issue text and the
 * repository, nothing else — whose only job is a minimal failing test for the
 * reported bug. The test is copied to the host and the container reset, so it
 * never sits where an implementer could edit it; the `repro` check pipes it in
 * at check time and removes it again (checks.ts, `reproCheckSource`).
 *
 * `checkFidelity` asks of every stored test whether it fails at the base
 * commit and passes with the upstream fix applied. Only a faithful test may be
 * used as a check. This step calls no model.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition, CrewResult, Task } from '@joule/shared';
import { contributionOf, crewBilling } from '../crew-scaling/record.js';
import type { AgentContribution } from '../crew-scaling/types.js';
import { isDjango, reproCheckSource, reproPath, reproRunCommand } from './checks.js';
import type { ReproCheck, SweItem } from './workload.js';

/** Bumped whenever the author's prompt changes; recorded with every generated test. */
/**
 * v1: the first dev pass (2026-10-02). v2 adds one instruction — write the file
 * early, then refine it — after 3 of 13 v1 authors spent all 30 turns reading
 * without creating it. Each record keeps the version that produced it.
 */
export const REPRO_PROMPT_VERSION = 'repro-author-v2';

const ISSUE_CAP = 6000;

/** The task the reproduction-test author is given. Recorded in full in the manifest. */
export function reproTaskDescription(item: SweItem): string {
  const issue = item.problem_statement.length > ISSUE_CAP
    ? `${item.problem_statement.slice(0, ISSUE_CAP)}\n... [issue truncated]`
    : item.problem_statement;
  const style = isDjango(item)
    ? 'a Django test case (django.test.SimpleTestCase, or TestCase if it needs the database). The directory '
      + `${reproPath(item).replace(/\/tests\.py$/, '')} is a test package: create an empty __init__.py next to tests.py so the runner can import it.`
    : 'a plain pytest test function (fixtures the repository\'s own test suite provides may be used).';
  return [
    `Repository: ${item.repo} (a working copy is checked out at /testbed inside this environment)`,
    '',
    'Reported issue:',
    issue.trim(),
    '',
    `Write ONE minimal automated test that reproduces this issue, at exactly this path: ${reproPath(item)}`,
    '',
    'Your turns are limited. Create the test file early - after a few reads at most - then run it and refine it. A test file that exists and is nearly right is worth more than further reading.',
    '',
    'Requirements:',
    '- The test must FAIL on the current code because of the reported bug, and PASS once the bug is fixed the way the issue asks.',
    '- Assert the behaviour the issue says is correct (the expected result), not the current wrong behaviour.',
    '- It must fail with an assertion about that behaviour, or with the exact error the issue reports - never with an ImportError, NameError, syntax error or missing fixture caused by the test itself.',
    '- Use only behaviour a user can observe as the issue describes it; do not depend on how a fix would be implemented (no new function names, no private internals that a fix might change).',
    `- Keep it small: one to three test functions, ${style}`,
    '- No network access, no sleeps, no reliance on files outside the repository.',
    '- Do not change any other file, and do not fix the bug.',
    '',
    `Run it with: ${reproRunCommand(item)}`,
    'Confirm it fails, and that the failure is the bug from the issue rather than a mistake in the test. If it fails for any other reason, correct the test and run it again.',
    'Finish with a short answer: the test name and, in one sentence, why it fails on the current code.',
  ].join('\n');
}

/** What one generation run produced. */
export interface ReproRecord {
  instanceId: string;
  promptVersion: string;
  path: string;
  /** 1 for the first generation run; higher when an issue with no stored test was run again */
  attempt?: number;
  /** Whether a test was found at `path` after the agent finished */
  stored: boolean;
  file?: string;
  chars?: number;
  agentStatus?: string;
  /** Why the author agent's run ended, when it failed */
  agentError?: string;
  /** Every tool call the author made, with its (redacted, truncated) arguments */
  tools?: AgentContribution['tools'];
  error?: string;
  answer?: string;
  tokens?: number;
  costUsd?: number;
  billedCostUsd?: number;
  modelCalls?: number;
  toolCalls?: number;
}

export interface ReproGenDeps {
  /** Lay the instance out at its base commit, nothing else applied */
  prepare(item: SweItem): { container: string };
  runAgent(agent: AgentDefinition, task: Task): Promise<CrewResult>;
  /** The file's content in the container, or null when it does not exist */
  readFile(container: string, path: string): string | null;
  /** Back to the base commit, removing whatever the author left */
  reset(container: string, item: SweItem): void;
}

/**
 * One author run per item; each test is stored at `<dir>/<instance>.py`, with a line in repro.jsonl.
 *
 * `keep` are records from earlier passes that stay in repro.jsonl unchanged
 * (a retry of the issues that stored no test keeps them all, failed attempts
 * included, so the log holds every attempt); `attempt` labels this pass.
 */
export async function generateRepros(
  items: readonly SweItem[],
  dir: string,
  author: AgentDefinition,
  deps: ReproGenDeps,
  log: (line: string) => void = () => {},
  options: { keep?: readonly ReproRecord[]; attempt?: number } = {},
): Promise<ReproRecord[]> {
  mkdirSync(dir, { recursive: true });
  const kept = options.keep ?? [];
  const records: ReproRecord[] = [];
  for (const item of items) {
    const path = reproPath(item);
    const base: ReproRecord = {
      instanceId: item.instance_id, promptVersion: REPRO_PROMPT_VERSION, path, stored: false,
      ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    };
    let record: ReproRecord = base;
    let container: string | undefined;
    try {
      container = deps.prepare(item).container;
      const task: Task = {
        id: `repro-${item.instance_id}`,
        description: reproTaskDescription(item),
        createdAt: new Date().toISOString(),
      };
      const crew = await deps.runAgent(author, task);
      const contributions = crew.agentResults.map(contributionOf);
      const billing = crewBilling(contributions);
      const source = deps.readFile(container, path);
      const file = join(dir, `${item.instance_id}.py`);
      if (source !== null && source.trim().length > 0) writeFileSync(file, source);
      record = {
        ...base,
        stored: source !== null && source.trim().length > 0,
        ...(source !== null && source.trim().length > 0 ? { file, chars: source.length } : {}),
        agentStatus: crew.agentResults[0]?.taskResult.status ?? crew.status,
        ...(contributions[0]?.error ? { agentError: contributions[0].error } : {}),
        ...(contributions[0]?.tools ? { tools: contributions[0].tools } : {}),
        ...(contributions[0]?.answer ? { answer: contributions[0].answer } : {}),
        tokens: crew.budgetUsed?.tokensUsed,
        costUsd: crew.budgetUsed?.costUsd,
        ...(billing.totalBilledCostUsd !== undefined ? { billedCostUsd: billing.totalBilledCostUsd } : {}),
        modelCalls: contributions.reduce((s, c) => s + c.modelCalls, 0),
        toolCalls: contributions.reduce((s, c) => s + c.toolCalls, 0),
      };
    } catch (err) {
      record = { ...base, error: err instanceof Error ? err.message.split('\n')[0] : String(err) };
    } finally {
      if (container) {
        try { deps.reset(container, item); } catch { /* the next prepare resets again */ }
      }
    }
    records.push(record);
    writeFileSync(join(dir, 'repro.jsonl'), [...kept, ...records].map(r => JSON.stringify(r)).join('\n') + '\n');
    const why = record.error ?? record.agentError;
    log(`${item.instance_id}: ${record.stored ? `stored (${record.chars} chars)` : `no test${why ? ` (${why.slice(0, 200)})` : ''}`}`);
  }
  return records;
}

// ── fidelity ─────────────────────────────────────────────────────────

export interface FidelityRow {
  instanceId: string;
  failsAtBase: boolean;
  passesWithGold: boolean;
  faithful: boolean;
  /** The check's summary line(s) at base and with the gold patch */
  base: string;
  gold: string;
  error?: string;
}

export interface FidelityDeps {
  prepare(item: SweItem): { container: string };
  /** Run a program (Python source) in the container; exit status and output */
  runProgram(container: string, source: string): { status: number; output: string };
  applyGold(container: string, item: SweItem): { ok: boolean; error?: string };
  reset(container: string, item: SweItem): void;
}

const summaryOf = (output: string): string =>
  output.split('\n').filter(l => l.startsWith('CHECK:')).join(' | ') || output.trim().split('\n').slice(-1)[0] || '';

/** Does each stored reproduction test fail at the base commit and pass with the upstream fix? */
export function checkFidelity(items: readonly SweItem[], repros: ReadonlyMap<string, string>, deps: FidelityDeps): FidelityRow[] {
  const rows: FidelityRow[] = [];
  for (const item of items) {
    const source = repros.get(item.instance_id);
    if (source === undefined) continue;
    const program = reproCheckSource(item, source, { existing: false });
    let container: string | undefined;
    try {
      container = deps.prepare(item).container;
      const atBase = deps.runProgram(container, program);
      const gold = deps.applyGold(container, item);
      const withGold = gold.ok ? deps.runProgram(container, program) : { status: 1, output: `gold patch did not apply: ${gold.error ?? ''}` };
      const failsAtBase = atBase.status !== 0;
      const passesWithGold = withGold.status === 0;
      rows.push({
        instanceId: item.instance_id,
        failsAtBase,
        passesWithGold,
        faithful: failsAtBase && passesWithGold,
        base: summaryOf(atBase.output),
        gold: summaryOf(withGold.output),
      });
    } catch (err) {
      rows.push({
        instanceId: item.instance_id, failsAtBase: false, passesWithGold: false, faithful: false, base: '', gold: '',
        error: err instanceof Error ? err.message.split('\n')[0] : String(err),
      });
    } finally {
      if (container) {
        try { deps.reset(container, item); } catch { /* the next prepare resets again */ }
      }
    }
  }
  return rows;
}

/** The fidelity table as Markdown, one row per issue and a total. */
export function renderFidelity(rows: readonly FidelityRow[]): string {
  const yes = (b: boolean) => (b ? 'yes' : 'no');
  const lines = [
    '| issue | fails at base | passes with gold | faithful | at base | with gold |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.instanceId} | ${yes(r.failsAtBase)} | ${yes(r.passesWithGold)} | **${yes(r.faithful)}** | ${(r.error ?? r.base).replace(/\|/g, '\\|').slice(0, 120)} | ${r.gold.replace(/\|/g, '\\|').slice(0, 120)} |`),
    '',
    `Faithful: ${rows.filter(r => r.faithful).length} of ${rows.length} stored reproduction tests.`,
  ];
  return lines.join('\n') + '\n';
}

/** Stored tests in `dir` (`<instance>.py`), by instance id. */
export function readStoredRepros(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith('.py')) out.set(name.slice(0, -'.py'.length), readFileSync(join(dir, name), 'utf8'));
  }
  return out;
}

/**
 * The reproduction tests a `repro`-mode run may use, with their fidelity.
 * Requires `fidelity.json` from `repro-fidelity`: a test that was never
 * checked is not a check.
 */
export function loadReproChecks(dir: string): Map<string, ReproCheck> {
  const fidelityFile = join(dir, 'fidelity.json');
  if (!existsSync(fidelityFile)) throw new Error(`no ${fidelityFile}: run repro-fidelity first`);
  const fidelity = new Map((JSON.parse(readFileSync(fidelityFile, 'utf8')) as FidelityRow[]).map(r => [r.instanceId, r.faithful]));
  const out = new Map<string, ReproCheck>();
  for (const [id, source] of readStoredRepros(dir)) {
    if (fidelity.has(id)) out.set(id, { source, faithful: fidelity.get(id) === true });
  }
  return out;
}
