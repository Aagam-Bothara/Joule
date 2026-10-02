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
import type { HiddenScore } from './checks.js';
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

/** What one agent run cost and did, and how the repository scored afterwards. */
export interface BranchOutcome {
  agent: string;
  status?: string;
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

function outcome(agent: AgentDefinition, crew: CrewResult, checked: { passed: boolean; output: string }, hidden: HiddenScore): BranchOutcome {
  const contributions = crew.agentResults.map(contributionOf);
  const billing = crewBilling(contributions);
  const first = contributions[0];
  return {
    agent: agent.id,
    ...(first?.status ? { status: first.status } : {}),
    checkPassed: checked.passed,
    checkTail: tail(checked.output),
    hidden,
    tokens: crew.budgetUsed?.tokensUsed,
    costUsd: crew.budgetUsed?.costUsd,
    ...(billing.totalBilledCostUsd !== undefined ? { billedCostUsd: billing.totalBilledCostUsd } : {}),
    modelCalls: contributions.reduce((s, c) => s + c.modelCalls, 0),
    toolCalls: contributions.reduce((s, c) => s + c.toolCalls, 0),
    ...(first?.proposedWrites !== undefined ? { proposedWrites: first.proposedWrites, acceptedWrites: first.acceptedWrites } : {}),
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
  const stage1 = outcome(agents.implementer, implementerRun, checked, deps.scoreHidden(first.container, item));
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
      record.controls[control] = outcome(agent, run, after, deps.scoreHidden(fresh.container, item));
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      record.controls[control] = {
        agent: control === 'R' ? agents.reviewer.id : agents.implementer.id,
        checkPassed: false, checkTail: '', hidden: noScore(message), modelCalls: 0, toolCalls: 0, error: message,
      };
    }
  }
  return record;
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
