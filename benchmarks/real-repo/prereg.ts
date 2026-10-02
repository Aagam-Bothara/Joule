/**
 * The pre-registered rules for the real-repository experiments, as code.
 *
 * Written before any run of the experiments they govern (2026-10-02), and
 * mirrored in benchmarks/README.md ("Pre-registration"). Nothing here reads a
 * result to decide what a rule is: pools are fixed by self-tests, and the
 * thresholds are constants.
 *
 * Amended 2026-10-02, after commit ff01479 and before any G1/G2 run
 * (`PREREG_AMENDMENTS`, and "Amendment 1" in benchmarks/README.md): run counts
 * fixed, and reporting added — G2 by how stage 1 ended, G1 recoveries by what
 * preceded them, cost per control and arm, a secondary regression score and a
 * diff audit. No threshold and no decision rule changed.
 */

import type { CrewScalingRecord } from '../crew-scaling/types.js';
import type { BranchControl, BranchOutcome, BranchRecord, EndReason } from './branch.js';
import { BRANCH_CONTROLS, END_REASONS, endReasonOf, summarizeBranches } from './branch.js';
import type { ReproCheck, SweItem } from './workload.js';

// ── amendments ───────────────────────────────────────────────────────

export interface PreregAmendment { id: string; date: string; summary: string }

/** Every change to the pre-registration since commit ff01479, in order. */
export const PREREG_AMENDMENTS: readonly PreregAmendment[] = [
  {
    id: 'amendment-1',
    date: '2026-10-02',
    summary: 'After commit ff01479, before any G1/G2 run. Repro fallback applied (5 of 13 dev reproduction tests faithful): G1 and G2 run with --check visible-f2p on both pools. Run counts fixed: G1 one staged run per issue per pool; G2 3 seeds dev, 1 seed held-out. Reporting added without thresholds or decision changes: G2 by stage-1 end reason, G1 recoveries by preceding end reason, tokens and billed cost per control and arm, a secondary regression score, extended false passes and a diff audit.',
  },
];

/** G1: staged runs per issue in each pool (Amendment 1). */
export const G1_RUNS_PER_ISSUE = 1;
/** G2: seeds per issue in each pool (Amendment 1); no further seeds after any result is seen. */
export const G2_SEEDS = { dev: 3, 'held-out': 1 } as const;

// ── pools ────────────────────────────────────────────────────────────

/** Where the development pool's self-test lives (13 flask/pylint/pytest issues). */
export const DEV_SELFTEST = 'benchmarks/experiments/real-repo-validation/selftest.json';
/** Where the held-out pool's Django self-test and pool file live. */
export const HELD_OUT_DIR = 'benchmarks/experiments/real-repo-heldout';
export const HELD_OUT_SIZE = 30;

export interface SelftestRow { instanceId: string; repo?: string; usable: boolean }

/** The development pool: every self-test-usable instance, in id order. */
export function devPoolIds(rows: readonly SelftestRow[]): string[] {
  return rows.filter(r => r.usable).map(r => r.instanceId).sort();
}

/**
 * The held-out pool: the first HELD_OUT_SIZE self-test-usable Django instances
 * in instance-id order, excluding every development id. Only instances whose
 * image was already local were self-tested; nothing was pulled.
 */
export function heldOutPoolIds(rows: readonly SelftestRow[], devIds: readonly string[], size = HELD_OUT_SIZE): string[] {
  const dev = new Set(devIds);
  return rows
    .filter(r => r.usable && r.instanceId.startsWith('django__django-') && !dev.has(r.instanceId))
    .map(r => r.instanceId)
    .sort()
    .slice(0, size);
}

// ── repro checks ─────────────────────────────────────────────────────

/** Repro-mode runs fall back to visible-f2p when this many or fewer dev repro tests are faithful. */
export const REPRO_FALLBACK_MAX_FAITHFUL = 5;

export function reproFallback(faithful: number): boolean {
  return faithful <= REPRO_FALLBACK_MAX_FAITHFUL;
}

/**
 * Which items a repro-mode run can use. Only a faithful reproduction test is a
 * check; unfaithful or missing ones are skipped (and said so) unless
 * `allowUnfaithful`, in which case the run records `checkFaithful: false`.
 */
export function selectReproItems(
  items: readonly SweItem[],
  repros: ReadonlyMap<string, ReproCheck>,
  allowUnfaithful = false,
): { items: SweItem[]; skipped: Array<{ instanceId: string; reason: string }> } {
  const kept: SweItem[] = [];
  const skipped: Array<{ instanceId: string; reason: string }> = [];
  for (const item of items) {
    const repro = repros.get(item.instance_id);
    if (!repro) skipped.push({ instanceId: item.instance_id, reason: 'no reproduction test' });
    else if (!repro.faithful && !allowUnfaithful) skipped.push({ instanceId: item.instance_id, reason: 'reproduction test is not faithful' });
    else kept.push(item);
  }
  return { items: kept, skipped };
}

// ── G1: staged recovery with a check a user could have ─────────────

export const G1_MIN_EXTRA_RESOLVED = 2;
export const G1_MAX_FALSE_PASS_SHARE = 0.25;

export interface G1Result {
  runs: number;
  /** Final hidden score of the staged runs */
  stagedResolved: number;
  /** Hidden score after stage 1 of the same runs: the paired lone implementer */
  stage1Resolved: number;
  /** Staged stages whose check passed */
  checkPasses: number;
  /** ... of which the hidden tests failed at that point */
  falsePasses: number;
  falsePassShare: number;
  /** Runs missing a stage-1 or final hidden score (excluded from the counts) */
  unscored: number;
  confirmed: boolean;
}

/**
 * G1 on a staged arm's records: confirmed when staged resolves (hidden) at
 * least G1_MIN_EXTRA_RESOLVED more issues than its own stage-1 score, AND false
 * passes are under G1_MAX_FALSE_PASS_SHARE of check passes.
 */
export function evaluateG1(records: readonly CrewScalingRecord[]): G1Result {
  let staged = 0;
  let stage1 = 0;
  let unscored = 0;
  let checkPasses = 0;
  let falsePasses = 0;
  let runs = 0;
  for (const r of records) {
    if (!r.hidden || !r.stage1Hidden) { unscored++; continue; }
    runs++;
    if (r.hidden.resolved) staged++;
    if (r.stage1Hidden.resolved) stage1++;
    for (const stage of r.staged?.stages ?? []) {
      if (!stage.executed || stage.verification?.passed !== true) continue;
      const hidden = (stage.observation as { hidden?: { resolved?: boolean } } | undefined)?.hidden;
      if (hidden === undefined) continue;
      checkPasses++;
      if (hidden.resolved !== true) falsePasses++;
    }
  }
  const falsePassShare = checkPasses > 0 ? falsePasses / checkPasses : 0;
  return {
    runs,
    stagedResolved: staged,
    stage1Resolved: stage1,
    checkPasses,
    falsePasses,
    falsePassShare,
    unscored,
    confirmed: runs > 0 && staged - stage1 >= G1_MIN_EXTRA_RESOLVED && falsePassShare < G1_MAX_FALSE_PASS_SHARE,
  };
}

// ── G1 report (Amendment 1): reporting only, no threshold ───────────

/** A staged stage's observation, as `observeStage` in workload.ts records it. */
interface StageObservationRecord {
  hidden?: { resolved?: boolean };
  secondary?: { files?: number; regressed?: number; error?: string };
  audit?: { testInfraChanged?: unknown[]; suspicious?: unknown[] };
}

export interface ExtendedFalsePass {
  runId: string;
  workloadId: string;
  stage: number;
  reasons: string[];
}

/**
 * Check passes that look wrong by any measure, not only the hidden tests:
 * the stage's check passed and the hidden tests failed, or the secondary
 * regression score found a regression, or the diff audit flagged changed test
 * infrastructure or suspicious source lines. Reporting only: G1's false-pass
 * rule counts hidden failures alone, as pre-registered.
 */
export interface ExtendedFalsePasses {
  /** Stages counted by evaluateG1 as check passes */
  checkPasses: number;
  hiddenFailed: number;
  secondaryRegressed: number;
  /** Check passes after which the secondary score ran no test file (not "clean") */
  secondaryNoFiles: number;
  testInfraChanged: number;
  suspicious: number;
  /** Check passes flagged for at least one reason */
  flagged: number;
  stages: ExtendedFalsePass[];
}

export interface G1Report {
  /** Scored staged runs resolved (hidden) whose stage 1 was not */
  recoveries: number;
  /**
   * How the stage before the solving stage ended, per recovery. The solving
   * stage is the first whose hidden score resolved (else `staged.solvedAtStage`).
   */
  recoveriesByPrecedingEnd: Partial<Record<EndReason, number>>;
  /** Recoveries whose solving or preceding stage could not be identified */
  unattributedRecoveries: number;
  /** Mean provider-billed cost per run, over the runs that reported one */
  meanBilledUsd?: number;
  billedRuns: number;
  runs: number;
  extendedFalsePasses: ExtendedFalsePasses;
}

const observationOf = (stage: { observation?: Record<string, unknown> }): StageObservationRecord | undefined =>
  stage.observation as StageObservationRecord | undefined;

/**
 * What G1's result is made of, for the report. It reads the same records and
 * changes nothing `evaluateG1` decides.
 */
export function describeG1(records: readonly CrewScalingRecord[]): G1Report {
  const byEnd: Partial<Record<EndReason, number>> = {};
  let recoveries = 0;
  let unattributed = 0;
  const extended: ExtendedFalsePasses = {
    checkPasses: 0, hiddenFailed: 0, secondaryRegressed: 0, secondaryNoFiles: 0, testInfraChanged: 0, suspicious: 0, flagged: 0, stages: [],
  };

  for (const r of records) {
    if (!r.hidden || !r.stage1Hidden) continue;
    const stages = r.staged?.stages ?? [];

    if (r.hidden.resolved && !r.stage1Hidden.resolved) {
      recoveries++;
      const solving = stages.find(s => s.executed && observationOf(s)?.hidden?.resolved === true)?.stage ?? r.staged?.solvedAtStage;
      const preceding = solving !== undefined ? stages.find(s => s.stage === solving - 1 && s.executed) : undefined;
      if (preceding) {
        const reason = endReasonOf({ status: preceding.status, error: preceding.error });
        byEnd[reason] = (byEnd[reason] ?? 0) + 1;
      } else {
        unattributed++;
      }
    }

    for (const stage of stages) {
      if (!stage.executed || stage.verification?.passed !== true) continue;
      const obs = observationOf(stage);
      if (obs?.hidden === undefined) continue;
      extended.checkPasses++;
      const reasons: string[] = [];
      if (obs.hidden.resolved !== true) { extended.hiddenFailed++; reasons.push('hidden tests failed'); }
      if ((obs.secondary?.regressed ?? 0) > 0) { extended.secondaryRegressed++; reasons.push('secondary regression'); }
      if (obs.secondary && !obs.secondary.error && obs.secondary.files === 0) extended.secondaryNoFiles++;
      if ((obs.audit?.testInfraChanged?.length ?? 0) > 0) { extended.testInfraChanged++; reasons.push('test infrastructure changed'); }
      if ((obs.audit?.suspicious?.length ?? 0) > 0) { extended.suspicious++; reasons.push('suspicious source lines'); }
      if (reasons.length > 0) {
        extended.flagged++;
        extended.stages.push({ runId: r.runId, workloadId: r.workloadId, stage: stage.stage, reasons });
      }
    }
  }

  const billed = records.filter(r => typeof r.totalBilledCostUsd === 'number');
  return {
    recoveries,
    recoveriesByPrecedingEnd: byEnd,
    unattributedRecoveries: unattributed,
    ...(billed.length > 0 ? { meanBilledUsd: billed.reduce((s, r) => s + (r.totalBilledCostUsd ?? 0), 0) / billed.length } : {}),
    billedRuns: billed.length,
    runs: records.length,
    extendedFalsePasses: extended,
  };
}

// ── G2: evidence, or more turns? ─────────────────────────────────────

export const G2_MIN_BRANCH_POINTS = 15;
export const G2_MIN_RATE_GAP = 0.2;
export const G2_MIN_RATE_RATIO = 2;

/** G2's rates within one stratum of branch points (reporting only). */
export interface G2Stratum {
  branchPoints: number;
  rateR?: number;
  rateC0?: number;
  rateC1?: number;
}

/** What a control cost over G2's branch points, and what it bought (reporting only). */
export interface ControlCost {
  /** Runs of this control over the paired branch points (a control that failed to run is left out) */
  runs: number;
  /** Mean total tokens over the runs that recorded them; absent when none did */
  meanTokens?: number;
  /** Mean provider-billed cost over the runs that reported one; absent when none did */
  meanBilledUsd?: number;
  billedRuns: number;
  hiddenResolved: number;
  /** Hidden recoveries per billed dollar, over the runs that reported a billed cost; absent when nothing was billed */
  resolvedPerBilledUsd?: number;
}

export interface G2Result {
  branchPoints: number;
  rateR?: number;
  rateC0?: number;
  rateC1?: number;
  /** Enough branch points to judge at all */
  powered: boolean;
  confirmed: boolean;
  /**
   * Reporting only (Amendment 1), over the same branch points: the rates by how
   * stage 1 ended. No threshold; `confirmed` and `powered` never read it.
   */
  strata: Partial<Record<EndReason, G2Stratum>>;
  /** Reporting only (Amendment 1): tokens, billed cost and hidden recoveries per control */
  cost: Partial<Record<BranchControl, ControlCost>>;
}

/**
 * G2 over branch points pooled across issues and seeds: the evidence effect is
 * confirmed when R's hidden recovery rate exceeds C0's by at least
 * G2_MIN_RATE_GAP AND is at least G2_MIN_RATE_RATIO times C0's, over at least
 * G2_MIN_BRANCH_POINTS branch points where both ran.
 */
export function evaluateG2(records: readonly BranchRecord[]): G2Result {
  const paired = records.filter(r => r.branched && r.controls.R && !r.controls.R.error && r.controls.C0 && !r.controls.C0.error);
  const summary = summarizeBranches(paired);
  const rateR = summary.R?.rate;
  const rateC0 = summary.C0?.rate;
  const powered = paired.length >= G2_MIN_BRANCH_POINTS;
  const confirmed = powered && rateR !== undefined && rateC0 !== undefined
    && rateR - rateC0 >= G2_MIN_RATE_GAP
    && rateR >= G2_MIN_RATE_RATIO * rateC0;
  return {
    branchPoints: paired.length,
    ...(rateR !== undefined ? { rateR } : {}),
    ...(rateC0 !== undefined ? { rateC0 } : {}),
    ...(summary.C1 ? { rateC1: summary.C1.rate } : {}),
    powered,
    confirmed,
    strata: g2Strata(paired),
    cost: g2Cost(paired),
  };
}

const pct = (v: number | undefined): string => (v === undefined ? '—' : `${Math.round(v * 100)}%`);

/** The G2 report's strata and cost as text tables (reporting only). */
export function renderG2Report(g2: G2Result): string {
  const lines = [
    'G2 by how stage 1 ended (reporting only; no threshold):',
    '| stage 1 ended | branch points | R | C0 | C1 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...END_REASONS.filter(e => g2.strata[e]).map(e => {
      const s = g2.strata[e]!;
      return `| ${e} | ${s.branchPoints} | ${pct(s.rateR)} | ${pct(s.rateC0)} | ${pct(s.rateC1)} |`;
    }),
    '',
    'Cost per control (reporting only):',
    '| control | runs | mean tokens | mean billed | billed runs | hidden resolved | resolved per billed $ |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...BRANCH_CONTROLS.filter(c => g2.cost[c]).map(c => {
      const k = g2.cost[c]!;
      return `| ${c} | ${k.runs} | ${k.meanTokens === undefined ? '—' : Math.round(k.meanTokens)} | ${k.meanBilledUsd === undefined ? '—' : `$${k.meanBilledUsd.toFixed(4)}`} | ${k.billedRuns} | ${k.hiddenResolved} | ${k.resolvedPerBilledUsd === undefined ? '—' : k.resolvedPerBilledUsd.toFixed(1)} |`;
    }),
  ];
  return lines.join('\n');
}

/** How stage 1 ended; records from before the amendment carry no endReason, so it is read from status. */
export const stage1EndReason = (r: BranchRecord): EndReason =>
  r.stage1.endReason ?? endReasonOf({ status: r.stage1.status, error: r.stage1.agentError });

function g2Strata(paired: readonly BranchRecord[]): Partial<Record<EndReason, G2Stratum>> {
  const groups = new Map<EndReason, BranchRecord[]>();
  for (const r of paired) {
    const reason = stage1EndReason(r);
    groups.set(reason, [...(groups.get(reason) ?? []), r]);
  }
  const out: Partial<Record<EndReason, G2Stratum>> = {};
  for (const reason of END_REASONS) {
    const group = groups.get(reason);
    if (!group) continue;
    const summary = summarizeBranches(group);
    out[reason] = {
      branchPoints: group.length,
      ...(summary.R ? { rateR: summary.R.rate } : {}),
      ...(summary.C0 ? { rateC0: summary.C0.rate } : {}),
      ...(summary.C1 ? { rateC1: summary.C1.rate } : {}),
    };
  }
  return out;
}

function g2Cost(paired: readonly BranchRecord[]): Partial<Record<BranchControl, ControlCost>> {
  const out: Partial<Record<BranchControl, ControlCost>> = {};
  for (const control of BRANCH_CONTROLS) {
    const runs = paired.map(r => r.controls[control]).filter((o): o is BranchOutcome => o !== undefined && o.error === undefined);
    if (runs.length === 0) continue;
    out[control] = controlCost(runs);
  }
  return out;
}

/** Cost and hidden recoveries over some agent runs (reporting only). */
export function controlCost(runs: readonly BranchOutcome[]): ControlCost {
  const withTokens = runs.filter(o => typeof o.tokens === 'number');
  const billed = runs.filter(o => typeof o.billedCostUsd === 'number');
  const billedUsd = billed.reduce((s, o) => s + (o.billedCostUsd ?? 0), 0);
  return {
    runs: runs.length,
    ...(withTokens.length > 0 ? { meanTokens: withTokens.reduce((s, o) => s + (o.tokens ?? 0), 0) / withTokens.length } : {}),
    ...(billed.length > 0 ? { meanBilledUsd: billedUsd / billed.length } : {}),
    billedRuns: billed.length,
    hiddenResolved: runs.filter(o => o.hidden.resolved).length,
    ...(billedUsd > 0 ? { resolvedPerBilledUsd: billed.filter(o => o.hidden.resolved).length / billedUsd } : {}),
  };
}
