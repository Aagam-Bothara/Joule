/**
 * The pre-registered rules for the real-repository experiments, as code.
 *
 * Written before any run of the experiments they govern (2026-10-02), and
 * mirrored in benchmarks/README.md ("Pre-registration"). Nothing here reads a
 * result to decide what a rule is: pools are fixed by self-tests, and the
 * thresholds are constants.
 */

import type { CrewScalingRecord } from '../crew-scaling/types.js';
import type { BranchRecord } from './branch.js';
import { summarizeBranches } from './branch.js';
import type { ReproCheck, SweItem } from './workload.js';

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

// ── G2: evidence, or more turns? ─────────────────────────────────────

export const G2_MIN_BRANCH_POINTS = 15;
export const G2_MIN_RATE_GAP = 0.2;
export const G2_MIN_RATE_RATIO = 2;

export interface G2Result {
  branchPoints: number;
  rateR?: number;
  rateC0?: number;
  rateC1?: number;
  /** Enough branch points to judge at all */
  powered: boolean;
  confirmed: boolean;
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
  };
}
