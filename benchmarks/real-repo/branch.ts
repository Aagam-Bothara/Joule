/**
 * Branch points: did the check's evidence help, or did more turns?
 *
 * Staged recovery hands a second agent two things at once — another full
 * allowance of turns, and the check's evidence of what is still wrong. A
 * branch point separates them. The implementer runs alone; if the check then
 * fails, the repository's state is saved as a diff (the branch point). Each
 * control starts from that exact state in a freshly reset container and runs
 * ONE agent with the same allowance:
 *
 *   R   the reviewer, handed exactly what staged recovery hands it (the
 *       previous agent's answer, the check's name and output, the objective)
 *   C0  the implementer prompt again, with no evidence: just the task
 *   C1  the implementer prompt plus the same evidence R gets
 *
 * Each control is scored by the check and by the hidden SWE-bench tests. The
 * hidden score is never shown to any agent.
 */

import type { AgentDefinition, AgentResult, CrewResult, Task, VerifiedEditPolicy } from '@joule/shared';
import { gatePolicy } from '../crew-scaling/tasks.js';
import { contributionOf, crewBilling } from '../crew-scaling/record.js';
import { failedAudit, type DiffAudit } from './audit.js';
import { failedSecondary, type CheckMode, type HiddenScore, type SecondaryScore } from './checks.js';
import type { PreparedInstance, SweItem } from './workload.js';

export type BranchControl = 'R' | 'C0' | 'C1';
export const BRANCH_CONTROLS: readonly BranchControl[] = ['R', 'C0', 'C1'];

export const CONTROL_DESCRIPTIONS: Record<BranchControl, string> = {
  R: 'reviewer prompt + the check evidence staged recovery hands a recovery stage (recoveryTask)',
  C0: 'implementer prompt, task only, no evidence',
  C1: 'implementer prompt + the same evidence R gets',
};

export function parseControls(value: string | undefined): BranchControl[] {
  const picked = (value ?? BRANCH_CONTROLS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  for (const c of picked) {
    if (!BRANCH_CONTROLS.includes(c as BranchControl)) throw new Error(`unknown control ${c}; expected one of ${BRANCH_CONTROLS.join(', ')}`);
  }
  return [...new Set(picked)] as BranchControl[];
}

/**
 * How an agent run ended, read from its status and error. For reporting only
 * (strata in the G2 report, recoveries by what preceded them in G1); no rule
 * reads it.
 *
 *   answered    the agent gave an answer (status completed)
 *   turn_cap    it ran out of turns
 *   wall_clock  it ran out of time
 *   budget      it ran out of tokens or money
 *   unreadable  its replies could not be read as a tool call or an answer
 *   error       anything else (a provider failure, a harness error)
 */
export type EndReason = 'answered' | 'turn_cap' | 'wall_clock' | 'budget' | 'unreadable' | 'error';
export const END_REASONS: readonly EndReason[] = ['answered', 'turn_cap', 'wall_clock', 'budget', 'unreadable', 'error'];

export function endReasonOf(run: { status?: string; error?: string }): EndReason {
  if (run.status === 'completed') return 'answered';
  const error = run.error ?? '';
  if (/Reached max iterations/.test(error)) return 'turn_cap';
  if (/Wall-clock timeout/.test(error)) return 'wall_clock';
  if (/Budget exhausted/.test(error)) return 'budget';
  if (/could not be parsed|empty response|without tool_calls/.test(error)) return 'unreadable';
  return 'error';
}

/** What one agent run cost and did, and how the repository scored afterwards. */
export interface BranchOutcome {
  agent: string;
  status?: string;
  /** How the agent's run ended (absent on records written before 2026-10-02's amendment) */
  endReason?: EndReason;
  /**
   * The agent's own error, when its run ended without an answer. Not `error`:
   * that field means the control itself failed to run and excludes it from
   * every rate.
   */
  agentError?: string;
  checkPassed: boolean;
  /** Last lines of the check's output, for the record (agents saw it via the gate) */
  checkTail: string;
  hidden: HiddenScore;
  tokens?: number;
  costUsd?: number;
  billedCostUsd?: number;
  modelCalls: number;
  toolCalls: number;
  proposedWrites?: number;
  acceptedWrites?: number;
  /**
   * Outside oracle mode: what the repository's diff from the base commit
   * touched (benchmarks/real-repo/audit.ts). Reporting only; no agent sees it.
   */
  audit?: DiffAudit;
  /** Outside oracle mode, when the check passed: the secondary regression score. Reporting only. */
  secondary?: SecondaryScore;
  /** Set when the control could not be run at all; such a control is left out of every rate */
  error?: string;
}

export interface BranchRecord {
  instanceId: string;
  seed: number;
  checkMode: string;
  checkFaithful?: boolean;
  /** The implementer alone */
  stage1: BranchOutcome;
  /** False when the check passed after the implementer: no branch point */
  branched: boolean;
  diffChars?: number;
  diffFile?: string;
  controls: Partial<Record<BranchControl, BranchOutcome>>;
}

export interface BranchDeps {
  /** A fresh, reset container laid out for the check mode */
  prepare(item: SweItem): PreparedInstance;
  runAgent(agent: AgentDefinition, task: Task): Promise<CrewResult>;
  /** The check, run the way the staged verifier runs it */
  verify(policy: VerifiedEditPolicy): Promise<{ passed: boolean; output: string }>;
  /** What a recovery stage is handed (core `recoveryTask` with `stageEvidence`) */
  recoveryTask(task: Task, policy: VerifiedEditPolicy, previous: readonly AgentResult[], checked: { passed: boolean; output: string }): Task;
  scoreHidden(container: string, item: SweItem): HiddenScore;
  /** Secondary regression score (reporting only); run only after a passing check, outside oracle mode */
  scoreSecondary(container: string, item: SweItem): SecondaryScore;
  /** What the diff from the base commit touched; reads only (reporting only), outside oracle mode */
  auditDiff(container: string, item: SweItem, mode: CheckMode): DiffAudit;
  captureDiff(container: string, item: SweItem): string;
  restoreBranch(container: string, item: SweItem, diff: string): void;
  /** Store the branch diff; returns where */
  saveDiff(item: SweItem, seed: number, diff: string): string;
}

export interface BranchAgents {
  implementer: AgentDefinition;
  reviewer: AgentDefinition;
}

const tail = (s: string, lines = 6): string => s.trim().split('\n').slice(-lines).join('\n');

/** For the record only, after the hidden score: the diff audit, and the secondary score after a passing check. */
interface Extra { audit?: DiffAudit; secondary?: SecondaryScore }

/**
 * A measurement that fails is recorded as failed, never thrown: inside a
 * control, a throw would mark the control as not run and drop it from G2's
 * rates, letting a reporting measurement change a decision input.
 */
function measureExtra(deps: BranchDeps, prepared: PreparedInstance, item: SweItem, passed: boolean): Extra {
  if (prepared.mode === 'oracle') return {};
  let audit: DiffAudit;
  try { audit = deps.auditDiff(prepared.container, item, prepared.mode); } catch (err) { audit = failedAudit(err); }
  if (!passed) return { audit };
  let secondary: SecondaryScore;
  try { secondary = deps.scoreSecondary(prepared.container, item); } catch (err) { secondary = failedSecondary(err); }
  return { audit, secondary };
}

function outcome(agent: AgentDefinition, crew: CrewResult, checked: { passed: boolean; output: string }, hidden: HiddenScore, extra: Extra = {}): BranchOutcome {
  const contributions = crew.agentResults.map(contributionOf);
  const billing = crewBilling(contributions);
  const first = contributions[0];
  return {
    agent: agent.id,
    ...(first?.status ? { status: first.status } : {}),
    endReason: endReasonOf({ status: first?.status, error: first?.error }),
    ...(first?.error ? { agentError: first.error } : {}),
    checkPassed: checked.passed,
    checkTail: tail(checked.output),
    hidden,
    tokens: crew.budgetUsed?.tokensUsed,
    costUsd: crew.budgetUsed?.costUsd,
    ...(billing.totalBilledCostUsd !== undefined ? { billedCostUsd: billing.totalBilledCostUsd } : {}),
    modelCalls: contributions.reduce((s, c) => s + c.modelCalls, 0),
    toolCalls: contributions.reduce((s, c) => s + c.toolCalls, 0),
    ...(first?.proposedWrites !== undefined ? { proposedWrites: first.proposedWrites, acceptedWrites: first.acceptedWrites } : {}),
    ...(extra.audit ? { audit: extra.audit } : {}),
    ...(extra.secondary ? { secondary: extra.secondary } : {}),
  };
}

const noScore = (error: string): HiddenScore => ({ resolved: false, f2pPassed: 0, f2pTotal: 0, p2pFailed: 0, p2pTotal: 0, error });

function taskFor(prepared: PreparedInstance, id: string): { task: Task; policy: VerifiedEditPolicy } {
  const policy = gatePolicy(prepared);
  return {
    policy,
    task: { id, description: prepared.description, createdAt: new Date().toISOString(), verifiedEdit: policy },
  };
}

/** One branch point: the implementer alone, then each control from the same saved state. */
export async function runBranchPoint(
  item: SweItem,
  seed: number,
  controls: readonly BranchControl[],
  agents: BranchAgents,
  deps: BranchDeps,
): Promise<BranchRecord> {
  const first = deps.prepare(item);
  const faithful = first.checkFaithful;
  const { task, policy } = taskFor(first, `branch-${item.instance_id}-s${seed}-stage1`);
  const implementerRun = await deps.runAgent(agents.implementer, task);
  const checked = await deps.verify(policy);
  const stage1Hidden = deps.scoreHidden(first.container, item);
  const stage1 = outcome(agents.implementer, implementerRun, checked, stage1Hidden, measureExtra(deps, first, item, checked.passed));
  const record: BranchRecord = {
    instanceId: item.instance_id,
    seed,
    checkMode: first.mode,
    ...(faithful !== undefined ? { checkFaithful: faithful } : {}),
    stage1,
    branched: !checked.passed,
    controls: {},
  };
  if (checked.passed) return record;

  // The branch point: the implementer's work, replayable from the base commit.
  const diff = deps.captureDiff(first.container, item);
  record.diffChars = diff.length;
  record.diffFile = deps.saveDiff(item, seed, diff);
  const previous = implementerRun.agentResults.slice(0, 1);

  for (const control of controls) {
    try {
      const fresh = deps.prepare(item);
      deps.restoreBranch(fresh.container, item, diff);
      const base = taskFor(fresh, `branch-${item.instance_id}-s${seed}-${control}`);
      const agent = control === 'R' ? agents.reviewer : agents.implementer;
      const controlTask = control === 'C0' ? base.task : deps.recoveryTask(base.task, base.policy, previous, checked);
      const run = await deps.runAgent(agent, controlTask);
      const after = await deps.verify(base.policy);
      const hidden = deps.scoreHidden(fresh.container, item);
      record.controls[control] = outcome(agent, run, after, hidden, measureExtra(deps, fresh, item, after.passed));
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      record.controls[control] = {
        agent: control === 'R' ? agents.reviewer.id : agents.implementer.id,
        endReason: 'error',
        checkPassed: false, checkTail: '', hidden: noScore(message), modelCalls: 0, toolCalls: 0, error: message,
      };
    }
  }
  return record;
}

/** Tokens and billed cost of one kind of agent run, for the branch manifest. */
export interface RunBilling {
  /** Runs that ran (a control that failed to run is left out, as in every rate) */
  runs: number;
  /** Controls that failed to run: no tokens or cost were recorded for them */
  erroredRuns: number;
  totalTokens: number;
  /** null when no counted run reported a billed cost */
  totalBilledCostUsd: number | null;
  billedRuns: number;
}

/**
 * Tokens and provider-billed cost per agent run kind over every record, for
 * the manifest: stage 1 (the implementer alone) and each control. Controls
 * that failed to run are left out of the sums, as they are from G2's `cost`
 * (which counts only the paired branch points G2 is judged on) and from every
 * rate; they are counted in `erroredRuns`.
 */
export function billingByControl(records: readonly BranchRecord[]): Record<string, RunBilling> {
  const kinds: Array<[string, BranchOutcome[]]> = [
    ['stage1', records.map(r => r.stage1)],
    ...BRANCH_CONTROLS.map((c): [string, BranchOutcome[]] => [c, records.map(r => r.controls[c]).filter((o): o is BranchOutcome => o !== undefined)]),
  ];
  const out: Record<string, RunBilling> = {};
  for (const [kind, all] of kinds) {
    if (all.length === 0) continue;
    const runs = all.filter(o => o.error === undefined);
    const billed = runs.filter(o => typeof o.billedCostUsd === 'number');
    out[kind] = {
      runs: runs.length,
      erroredRuns: all.length - runs.length,
      totalTokens: runs.reduce((s, o) => s + (o.tokens ?? 0), 0),
      totalBilledCostUsd: billed.length > 0 ? billed.reduce((s, o) => s + (o.billedCostUsd ?? 0), 0) : null,
      billedRuns: billed.length,
    };
  }
  return out;
}

/** Pooled recovery rates per control over branch points (hidden score), for the analysis. */
export function summarizeBranches(records: readonly BranchRecord[]): Record<string, { branchPoints: number; checkPasses: number; hiddenResolved: number; rate: number }> {
  const branched = records.filter(r => r.branched);
  const out: Record<string, { branchPoints: number; checkPasses: number; hiddenResolved: number; rate: number }> = {};
  for (const control of BRANCH_CONTROLS) {
    const runs = branched.map(r => r.controls[control]).filter((o): o is BranchOutcome => o !== undefined && o.error === undefined);
    if (runs.length === 0) continue;
    const resolved = runs.filter(o => o.hidden.resolved).length;
    out[control] = { branchPoints: runs.length, checkPasses: runs.filter(o => o.checkPassed).length, hiddenResolved: resolved, rate: resolved / runs.length };
  }
  return out;
}
