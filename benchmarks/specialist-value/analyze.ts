/**
 * Dataset F analysis.
 *
 * Dataset E asked whether a wider crew scores better, which turned out to be
 * unanswerable from what was recorded. The questions here are narrower and
 * each one is decidable from a single run:
 *
 *   - the implementer left the repository failing: did a specialist repair it?
 *   - the implementer left it passing: did the specialist leave it alone?
 *   - what did each specialist actually do — start, inspect, diagnose, write?
 *
 * Every classification below comes from recorded fields. Where a judgement is
 * heuristic, it says so: naming the defect is scored by keyword overlap with
 * the fixture's planted defect, which is evidence, not proof.
 */

import { isMeasured } from '../crew-scaling/analyze.js';
import type { AgentContribution, CrewScalingRecord } from '../crew-scaling/types.js';
import { fixtureById, type DefectType } from './fixtures.js';
import { armOfWidth, ARM_WIDTH, ARMS, type Arm } from './tasks.js';

/** Keyword hits needed before crediting a specialist with naming the defect. */
const NAMED_DEFECT_THRESHOLD = 2;

/** What a specialist did, in the terms the experiment set out to separate. */
export type SpecialistOutcome =
  /** Never executed — no model call, no tool call */
  | 'never-started'
  /** Made a model call but never used a tool: it replied in prose and stopped */
  | 'no-tool-use'
  /** Ran, wrote nothing, and the repository was already passing when it began */
  | 'abstained-nothing-to-do'
  /** Ran against a failing repository, wrote nothing, and named no cause */
  | 'inspected-no-defect-found'
  /** Ran against a failing repository and described the defect, but wrote nothing */
  | 'identified-not-acted'
  /** Wrote, and the repository verified afterwards */
  | 'wrote-accepted'
  /** Wrote, and the gate restored the previous working state */
  | 'wrote-rolled-back'
  /** Wrote, and the repository still did not verify — but there was nothing to protect */
  | 'wrote-unverified';

export interface SpecialistBehaviour {
  role: string;
  ran: boolean;
  modelCalls: number;
  toolCalls: number;
  reads: number;
  writes: number;
  shell: number;
  proposedWrites: number;
  acceptedWrites: number;
  rolledBackWrites: number;
  /** Distinct planted-defect keywords the answer mentions */
  defectKeywordHits: number;
  namedDefect: boolean;
  outcome: SpecialistOutcome;
}

export interface SpecialistRow {
  workloadId: string;
  defectType?: DefectType;
  seed: number;
  arm: Arm;
  /** The suite passed when the run finished */
  success: boolean;
  /** The implementer's gate was passing when it stopped */
  primaryLeftPassing?: boolean;
  costUsd?: number;
  tokens?: number;
  specialists: SpecialistBehaviour[];
}

/**
 * The primary is whoever ran first, not whoever is called "Implementer": the
 * control arm fields two agents with that same role string.
 */
const primaryOf = (agents: readonly AgentContribution[]): AgentContribution | undefined => agents[0];

function countTools(agent: AgentContribution): { reads: number; writes: number; shell: number } {
  let reads = 0;
  let writes = 0;
  let shell = 0;
  for (const call of agent.tools ?? []) {
    if (call.tool === 'file_read') reads++;
    else if (call.tool === 'file_write') writes++;
    else if (call.tool === 'shell_exec') shell++;
  }
  return { reads, writes, shell };
}

/** Distinct planted keywords an answer mentions. Evidence of a diagnosis, not proof of one. */
export function defectKeywordHits(answer: string | undefined, keywords: readonly string[]): number {
  if (!answer) return 0;
  const haystack = answer.toLowerCase();
  return keywords.filter(k => haystack.includes(k.toLowerCase())).length;
}

function classify(agent: AgentContribution, hits: number): SpecialistOutcome {
  const ran = (agent.modelCalls ?? 0) > 0 || (agent.toolCalls ?? 0) > 0;
  if (!ran) return 'never-started';

  // Answered without looking at anything. Counting this as an inspection would
  // credit the role with work it did not do.
  if ((agent.toolCalls ?? 0) === 0) return 'no-tool-use';

  // A rollback is reported first: an agent that broke a working repository has
  // done something the experiment cares about more than whatever else it did.
  if ((agent.rolledBackWrites ?? 0) > 0) return 'wrote-rolled-back';
  if ((agent.acceptedWrites ?? 0) > 0) return 'wrote-accepted';
  if ((agent.proposedWrites ?? 0) > 0) return 'wrote-unverified';

  if (agent.verified === true) return 'abstained-nothing-to-do';
  return hits >= NAMED_DEFECT_THRESHOLD ? 'identified-not-acted' : 'inspected-no-defect-found';
}

export function rowsFrom(records: readonly CrewScalingRecord[]): SpecialistRow[] {
  const rows: SpecialistRow[] = [];
  for (const record of records) {
    const arm = armOfWidth(record.crewWidth);
    if (!arm) continue;
    const fixture = fixtureById(record.workloadId);
    const keywords = fixture?.defect.keywords ?? [];
    const primary = primaryOf(record.agentResults);

    const specialists = record.agentResults
      .slice(1)
      .map(agent => {
        const hits = defectKeywordHits(agent.answer, keywords);
        const tools = countTools(agent);
        return {
          role: agent.agentId === 'implementer-2' ? 'Implementer (2nd)' : (agent.role ?? agent.agentId),
          ran: (agent.modelCalls ?? 0) > 0 || (agent.toolCalls ?? 0) > 0,
          modelCalls: agent.modelCalls ?? 0,
          toolCalls: agent.toolCalls ?? 0,
          ...tools,
          proposedWrites: agent.proposedWrites ?? 0,
          acceptedWrites: agent.acceptedWrites ?? 0,
          rolledBackWrites: agent.rolledBackWrites ?? 0,
          defectKeywordHits: hits,
          namedDefect: hits >= NAMED_DEFECT_THRESHOLD,
          outcome: classify(agent, hits),
        };
      });

    rows.push({
      workloadId: record.workloadId,
      ...(fixture ? { defectType: fixture.defect.type } : {}),
      seed: record.seed,
      arm,
      success: record.success,
      ...(primary?.verified !== undefined ? { primaryLeftPassing: primary.verified } : {}),
      ...(record.totalCostUsd !== undefined ? { costUsd: record.totalCostUsd } : {}),
      ...(record.totalTokens !== undefined ? { tokens: record.totalTokens } : {}),
      specialists,
    });
  }
  return rows;
}

// ── Arm summaries ────────────────────────────────────────────────────

export interface ArmSummary {
  arm: Arm;
  attemptedRuns: number;
  measuredRuns: number;
  successes: number;
  successRate: number;
  meanCostUsd: number;
  costRuns: number;
  meanTokens: number;
  tokenRuns: number;
  /** Against arm A on the tasks both arms ran; absent for A itself */
  deltaSuccessRateVsA?: number;
  deltaCostPctVsA?: number;
}

const mean = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function armSummaries(records: readonly CrewScalingRecord[]): ArmSummary[] {
  const out: ArmSummary[] = [];
  const armsPresent = ARMS.filter(a => records.some(r => r.crewWidth === ARM_WIDTH[a]));
  const baseline = records.filter(r => r.crewWidth === ARM_WIDTH.A);

  for (const arm of armsPresent) {
    const rs = records.filter(r => r.crewWidth === ARM_WIDTH[arm]);
    const cost: number[] = [];
    const tokens: number[] = [];
    for (const r of rs) {
      if (r.totalCostUsd !== undefined) cost.push(r.totalCostUsd);
      if (r.totalTokens !== undefined) tokens.push(r.totalTokens);
    }
    const successes = rs.filter(r => r.success).length;
    const summary: ArmSummary = {
      arm,
      attemptedRuns: rs.length,
      measuredRuns: rs.filter(isMeasured).length,
      successes,
      successRate: rs.length > 0 ? successes / rs.length : 0,
      meanCostUsd: mean(cost),
      costRuns: cost.length,
      meanTokens: mean(tokens),
      tokenRuns: tokens.length,
    };

    if (arm !== 'A' && baseline.length > 0) {
      // Paired on (task, repetition), so an arm that ran fewer tasks is not
      // compared against tasks it never attempted.
      const keys = new Set(rs.map(r => `${r.workloadId}#${r.seed}`));
      const pairedBase = baseline.filter(r => keys.has(`${r.workloadId}#${r.seed}`));
      const baseKeys = new Set(pairedBase.map(r => `${r.workloadId}#${r.seed}`));
      const paired = rs.filter(r => baseKeys.has(`${r.workloadId}#${r.seed}`));
      if (paired.length > 0) {
        const baseRate = pairedBase.filter(r => r.success).length / pairedBase.length;
        const armRate = paired.filter(r => r.success).length / paired.length;
        summary.deltaSuccessRateVsA = armRate - baseRate;
        const baseCost = mean(pairedBase.filter(isMeasured).map(r => r.totalCostUsd));
        const armCost = mean(paired.filter(isMeasured).map(r => r.totalCostUsd));
        if (baseCost > 0) summary.deltaCostPctVsA = ((armCost - baseCost) / baseCost) * 100;
      }
    }
    out.push(summary);
  }
  return out;
}

// ── The two questions ────────────────────────────────────────────────

export interface RecoverySummary {
  /** Runs where the implementer left the repository failing and a specialist ran */
  opportunities: number;
  /** Of those, runs that ended passing */
  recovered: number;
  recoveryRate: number;
  /** Which role's accepted write coincided with the repair */
  byRole: Record<string, number>;
}

export function recovery(rows: readonly SpecialistRow[]): RecoverySummary {
  const opportunities = rows.filter(r =>
    r.primaryLeftPassing === false && r.specialists.some(s => s.ran));
  const recovered = opportunities.filter(r => r.success);
  const byRole: Record<string, number> = {};
  for (const row of recovered) {
    for (const s of row.specialists) {
      if (s.acceptedWrites > 0) byRole[s.role] = (byRole[s.role] ?? 0) + 1;
    }
  }
  return {
    opportunities: opportunities.length,
    recovered: recovered.length,
    recoveryRate: opportunities.length > 0 ? recovered.length / opportunities.length : 0,
    byRole,
  };
}

export interface AbstentionSummary {
  /** Runs where the implementer left the repository passing and a specialist ran */
  opportunities: number;
  /** Of those, runs that still passed at the end */
  safe: number;
  /** Of those, runs where the repository ended broken */
  regressions: number;
  safeRate: number;
  /** Writes the gate had to undo, across those runs */
  rollbacks: number;
}

export function abstention(rows: readonly SpecialistRow[]): AbstentionSummary {
  const opportunities = rows.filter(r =>
    r.primaryLeftPassing === true && r.specialists.some(s => s.ran));
  const safe = opportunities.filter(r => r.success).length;
  const rollbacks = opportunities.reduce(
    (sum, r) => sum + r.specialists.reduce((s, sp) => s + sp.rolledBackWrites, 0), 0);
  return {
    opportunities: opportunities.length,
    safe,
    regressions: opportunities.length - safe,
    safeRate: opportunities.length > 0 ? safe / opportunities.length : 0,
    rollbacks,
  };
}

/** How often each role ended a run in each way. */
export function outcomeCounts(rows: readonly SpecialistRow[]): Record<string, Record<SpecialistOutcome, number>> {
  const out: Record<string, Record<SpecialistOutcome, number>> = {};
  for (const row of rows) {
    for (const s of row.specialists) {
      const bucket = out[s.role] ?? (out[s.role] = {
        'never-started': 0,
        'no-tool-use': 0,
        'abstained-nothing-to-do': 0,
        'inspected-no-defect-found': 0,
        'identified-not-acted': 0,
        'wrote-accepted': 0,
        'wrote-rolled-back': 0,
        'wrote-unverified': 0,
      });
      bucket[s.outcome]++;
    }
  }
  return out;
}

export interface SpecialistValueAnalysis {
  generatedAt: string;
  source: string;
  attemptedRuns: number;
  measuredRuns: number;
  arms: ArmSummary[];
  recovery: RecoverySummary;
  abstention: AbstentionSummary;
  outcomes: Record<string, Record<SpecialistOutcome, number>>;
  rows: SpecialistRow[];
}

export function analyzeSpecialistValue(records: readonly CrewScalingRecord[], source: string): SpecialistValueAnalysis {
  const rows = rowsFrom(records);
  return {
    generatedAt: new Date().toISOString(),
    source,
    attemptedRuns: records.length,
    measuredRuns: records.filter(isMeasured).length,
    arms: armSummaries(records),
    recovery: recovery(rows),
    abstention: abstention(rows),
    outcomes: outcomeCounts(rows),
    rows,
  };
}

// ── Report ───────────────────────────────────────────────────────────

const pad = (v: unknown, n: number): string => String(v).padStart(n);
const padEnd = (v: unknown, n: number): string => String(v).padEnd(n);
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

export function renderSpecialistValueReport(a: SpecialistValueAnalysis): string {
  const lines: string[] = ['Specialist value (Dataset F)', ''];
  lines.push(`  source ${a.source}`);
  lines.push(`  ${a.attemptedRuns} run(s) attempted, ${a.measuredRuns} with resource measurements`);

  lines.push('', 'Arms  (success over attempts; cost over measured runs)');
  lines.push(padEnd('arm', 5) + pad('runs', 6) + pad('success', 10) + pad('meanCost', 11) + pad('meanTokens', 12) + pad('vs A', 10));
  lines.push('-'.repeat(54));
  for (const arm of a.arms) {
    const delta = arm.deltaSuccessRateVsA === undefined
      ? '-'
      : `${arm.deltaSuccessRateVsA >= 0 ? '+' : ''}${(arm.deltaSuccessRateVsA * 100).toFixed(0)}pp`;
    lines.push(
      padEnd(arm.arm, 5) + pad(arm.attemptedRuns, 6)
      + pad(`${arm.successes}/${arm.attemptedRuns}`, 10)
      + pad(`$${arm.meanCostUsd.toFixed(4)}`, 11)
      + pad(Math.round(arm.meanTokens), 12)
      + pad(delta, 10),
    );
  }

  lines.push('', 'When the implementer left it failing');
  lines.push(`  ${a.recovery.recovered}/${a.recovery.opportunities} recovered (${pct(a.recovery.recoveryRate)})`);
  for (const [role, count] of Object.entries(a.recovery.byRole).sort()) {
    lines.push(`    ${role}: ${count} accepted repair(s)`);
  }

  lines.push('', 'When the implementer left it passing');
  lines.push(`  ${a.abstention.safe}/${a.abstention.opportunities} still passing (${pct(a.abstention.safeRate)}), `
    + `${a.abstention.regressions} regressed, ${a.abstention.rollbacks} write(s) rolled back`);

  lines.push('', 'What each specialist did');
  for (const [role, counts] of Object.entries(a.outcomes).sort()) {
    lines.push(`  ${role}`);
    for (const [outcome, count] of Object.entries(counts)) {
      if (count > 0) lines.push(`    ${padEnd(outcome, 28)}${count}`);
    }
  }

  return lines.join('\n');
}
