/**
 * Crew-scaling analysis: scaling curve, paired marginal returns, dominance,
 * minimum sufficient width, and the oracle elastic bound.
 *
 * Everything paired is computed only over tasks that ran at both widths, so a
 * missing run never inflates a comparison. Output ordering is deterministic.
 */

import { percentile } from '../lifecycle/analyze.js';
import type {
  CrewScalingAnalysis,
  CrewScalingRecord,
  CrewWidth,
  DominanceStep,
  MarginalStep,
  MinimumWidthSummary,
  OracleSavings,
  WidthAggregate,
} from './types.js';

export const WIDTHS: CrewWidth[] = [1, 2, 3, 4];

const mean = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Values a metric actually has, in run order.
 *
 * Validity is presence, never value: a run that genuinely cost nothing reports
 * 0 and belongs in the average, while a run that never got far enough to cost
 * anything reports nothing and does not.
 */
function values(
  records: readonly CrewScalingRecord[],
  pick: (r: CrewScalingRecord) => number | undefined,
): number[] {
  const out: number[] = [];
  for (const r of records) {
    const v = pick(r);
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** A run whose resource measurements exist and can be compared or averaged. */
export type MeasuredRun = CrewScalingRecord & {
  workflowJctMs: number;
  totalCostUsd: number;
  totalTokens: number;
};

/** Did this run measure the resources it consumed? */
export function isMeasured(r: CrewScalingRecord): r is MeasuredRun {
  return r.workflowJctMs !== undefined && r.totalCostUsd !== undefined && r.totalTokens !== undefined;
}

/** workloadId -> width -> record, with tasks in a stable order. */
export function byTask(records: readonly CrewScalingRecord[]): Map<string, Map<CrewWidth, CrewScalingRecord>> {
  const out = new Map<string, Map<CrewWidth, CrewScalingRecord>>();
  for (const id of [...new Set(records.map(r => r.workloadId))].sort()) {
    const perWidth = new Map<CrewWidth, CrewScalingRecord>();
    for (const width of WIDTHS) {
      const found = records.find(r => r.workloadId === id && r.crewWidth === width);
      if (found) perWidth.set(width, found);
    }
    out.set(id, perWidth);
  }
  return out;
}

export function aggregateByWidth(records: readonly CrewScalingRecord[]): WidthAggregate[] {
  return WIDTHS.flatMap(width => {
    const rs = records.filter(r => r.crewWidth === width);
    if (rs.length === 0) return [];

    // Outcomes are counted over every attempt; resources only over the runs
    // that measured them, and each metric reports its own denominator.
    const jct = values(rs, r => r.workflowJctMs);
    const cost = values(rs, r => r.totalCostUsd);
    const tokens = values(rs, r => r.totalTokens);
    const successes = rs.filter(r => r.success).length;

    return [{
      crewWidth: width,
      runs: rs.length,
      attemptedRuns: rs.length,
      measuredRuns: rs.filter(isMeasured).length,
      jctRuns: jct.length,
      costRuns: cost.length,
      tokenRuns: tokens.length,
      successes,
      successRate: successes / rs.length,
      meanJctMs: mean(jct),
      medianJctMs: percentile(jct, 0.5),
      meanCostUsd: mean(cost),
      medianCostUsd: percentile(cost, 0.5),
      meanTokens: mean(tokens),
      meanModelCalls: mean(values(rs, r => r.modelCalls)),
      meanToolCalls: mean(values(rs, r => r.toolCalls)),
      meanActiveAgents: mean(values(rs, r => r.activeAgents)),
      activeAgentFraction: mean(values(rs, r => (r.activeAgents === undefined ? undefined : r.activeAgents / r.crewWidth))),
    }];
  });
}

/** Pairs present at both widths, in task order. */
function pairs(
  records: readonly CrewScalingRecord[],
  from: CrewWidth,
  to: CrewWidth,
): Array<{ from: CrewScalingRecord; to: CrewScalingRecord }> {
  const out: Array<{ from: CrewScalingRecord; to: CrewScalingRecord }> = [];
  for (const perWidth of byTask(records).values()) {
    const a = perWidth.get(from);
    const b = perWidth.get(to);
    if (a && b) out.push({ from: a, to: b });
  }
  return out;
}

export function marginalSteps(records: readonly CrewScalingRecord[]): MarginalStep[] {
  const steps: MarginalStep[] = [];
  for (let i = 0; i < WIDTHS.length - 1; i++) {
    const from = WIDTHS[i];
    const to = WIDTHS[i + 1];
    const ps = pairs(records, from, to);
    if (ps.length === 0) continue;

    const newlySolved = ps.filter(p => p.to.success && !p.from.success).length;
    const regressions = ps.filter(p => !p.to.success && p.from.success).length;
    const netSolved = newlySolved - regressions;

    // Outcomes come from every pair; a resource delta needs both sides to have
    // measured the resource, so those use their own, smaller set.
    const measured = ps.filter((p): p is { from: MeasuredRun; to: MeasuredRun } =>
      isMeasured(p.from) && isMeasured(p.to));
    const deltaCostUsd = sum(measured.map(p => p.to.totalCostUsd - p.from.totalCostUsd));
    const fromCost = sum(measured.map(p => p.from.totalCostUsd));
    const deltaTokens = sum(measured.map(p => p.to.totalTokens - p.from.totalTokens));
    const deltaJctMs = mean(measured.map(p => p.to.workflowJctMs - p.from.workflowJctMs));
    const fromJct = mean(measured.map(p => p.from.workflowJctMs));

    steps.push({
      from,
      to,
      pairedTasks: ps.length,
      measuredPairs: measured.length,
      newlySolved,
      regressions,
      netSolved,
      deltaCostUsd,
      deltaCostPct: fromCost > 0 ? (deltaCostUsd / fromCost) * 100 : 0,
      deltaJctMs,
      deltaJctPct: fromJct > 0 ? (deltaJctMs / fromJct) * 100 : 0,
      deltaTokens,
      deltaModelCalls: sum(measured.map(p => (p.to.modelCalls ?? 0) - (p.from.modelCalls ?? 0))),
      deltaToolCalls: sum(measured.map(p => (p.to.toolCalls ?? 0) - (p.from.toolCalls ?? 0))),
      ...(deltaCostUsd > 0 ? { solvedPerDollar: netSolved / deltaCostUsd } : {}),
      ...(deltaTokens > 0 ? { solvedPerMillionTokens: netSolved / (deltaTokens / 1_000_000) } : {}),
    });
  }
  return steps;
}

export function dominanceSteps(records: readonly CrewScalingRecord[]): DominanceStep[] {
  const steps: DominanceStep[] = [];
  for (let i = 0; i < WIDTHS.length - 1; i++) {
    const from = WIDTHS[i];
    const to = WIDTHS[i + 1];
    const ps = pairs(records, from, to);
    if (ps.length === 0) continue;
    // Dominance is a claim about money and latency, so it can only be made
    // about pairs where both runs measured them.
    const comparable = ps.filter((p): p is { from: MeasuredRun; to: MeasuredRun } =>
      isMeasured(p.from) && isMeasured(p.to));
    // Dominated: no better outcome, more money, and no better latency.
    const dominated = comparable.filter(p =>
      Number(p.to.success) <= Number(p.from.success)
      && p.to.totalCostUsd > p.from.totalCostUsd
      && p.to.workflowJctMs >= p.from.workflowJctMs).length;
    const sameOutcomeCheaper = comparable.filter(p => p.to.success === p.from.success && p.from.totalCostUsd < p.to.totalCostUsd).length;
    steps.push({
      from,
      to,
      pairedTasks: ps.length,
      comparablePairs: comparable.length,
      dominated,
      dominatedFraction: comparable.length > 0 ? dominated / comparable.length : 0,
      sameOutcomeCheaper,
    });
  }
  return steps;
}

export function minimumWidths(records: readonly CrewScalingRecord[]): MinimumWidthSummary {
  const byTaskMap = byTask(records);
  const solvedAtWidth: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let neverSolved = 0;
  const entries: MinimumWidthSummary['byTask'] = [];

  for (const [workloadId, perWidth] of byTaskMap) {
    const min = WIDTHS.find(w => perWidth.get(w)?.success) ?? null;
    entries.push({ workloadId, minimumSuccessfulWidth: min });
    if (min === null) neverSolved++;
    else solvedAtWidth[String(min)]++;
  }
  return { byTask: entries, solvedAtWidth, neverSolved };
}

/**
 * Oracle: spend each task's minimum successful width instead of always paying
 * for the widest. A task nobody solved keeps the widest run's cost, since no
 * cheaper width would have solved it either.
 */
export function oracleSavings(records: readonly CrewScalingRecord[], widest: CrewWidth = 4): OracleSavings {
  const byTaskMap = byTask(records);
  let alwaysWidestCostUsd = 0;
  let oracleCostUsd = 0;
  let alwaysWidestTokens = 0;
  let oracleTokens = 0;
  let alwaysWidestJctMs = 0;
  let oracleJctMs = 0;
  let alwaysWidestSolved = 0;
  let oracleSolved = 0;
  let tasksConsidered = 0;

  for (const perWidth of byTaskMap.values()) {
    const widestRun = perWidth.get(widest);
    // The comparison is about what each strategy would have spent, so a task
    // whose runs did not measure spending cannot take part in it.
    if (!widestRun || !isMeasured(widestRun)) continue;
    const minWidth = WIDTHS.find(w => perWidth.get(w)?.success);
    const picked = minWidth ? perWidth.get(minWidth)! : widestRun;
    if (!isMeasured(picked)) continue;
    const chosen: MeasuredRun = picked;

    tasksConsidered++;
    alwaysWidestCostUsd += widestRun.totalCostUsd;
    alwaysWidestTokens += widestRun.totalTokens;
    alwaysWidestJctMs += widestRun.workflowJctMs;
    if (widestRun.success) alwaysWidestSolved++;

    oracleCostUsd += chosen.totalCostUsd;
    oracleTokens += chosen.totalTokens;
    oracleJctMs += chosen.workflowJctMs;
    if (chosen.success) oracleSolved++;
  }

  const pct = (base: number, value: number): number => (base > 0 ? ((base - value) / base) * 100 : 0);
  return {
    tasksConsidered,
    alwaysWidestCostUsd,
    oracleCostUsd,
    costSavedUsd: alwaysWidestCostUsd - oracleCostUsd,
    costSavedPct: pct(alwaysWidestCostUsd, oracleCostUsd),
    alwaysWidestTokens,
    oracleTokens,
    tokensSavedPct: pct(alwaysWidestTokens, oracleTokens),
    alwaysWidestJctMs,
    oracleJctMs,
    jctChangePct: alwaysWidestJctMs > 0 ? ((oracleJctMs - alwaysWidestJctMs) / alwaysWidestJctMs) * 100 : 0,
    alwaysWidestSolved,
    oracleSolved,
  };
}

// ── Repeatability ────────────────────────────────────────────────────

export interface TaskRepeatability {
  workloadId: string;
  seeds: number;
  /** Successes out of repetitions, per width */
  successesByWidth: Record<string, { successes: number; runs: number }>;
  /** Minimum successful width per repetition; null where nothing worked */
  minimumWidthPerSeed: Array<CrewWidth | null>;
  /** Every repetition agreed on the minimum successful width */
  stableMinimumWidth: boolean;
  /** Every width was all-pass or all-fail across repetitions */
  deterministicOutcome: boolean;
}

/**
 * Whether a task's width behaviour survives repetition. Without this, a
 * "minimum successful width" is just one sample of a stochastic model.
 */
export function repeatability(records: readonly CrewScalingRecord[]): TaskRepeatability[] {
  const out: TaskRepeatability[] = [];
  for (const workloadId of [...new Set(records.map(r => r.workloadId))].sort()) {
    const mine = records.filter(r => r.workloadId === workloadId);
    const seedIds = [...new Set(mine.map(r => r.seed))].sort((a, b) => a - b);

    const successesByWidth: Record<string, { successes: number; runs: number }> = {};
    let deterministicOutcome = true;
    for (const width of WIDTHS) {
      const runs = mine.filter(r => r.crewWidth === width);
      if (runs.length === 0) continue;
      const successes = runs.filter(r => r.success).length;
      successesByWidth[String(width)] = { successes, runs: runs.length };
      if (successes !== 0 && successes !== runs.length) deterministicOutcome = false;
    }

    const minimumWidthPerSeed = seedIds.map(seed =>
      WIDTHS.find(w => mine.some(r => r.seed === seed && r.crewWidth === w && r.success)) ?? null);
    const stableMinimumWidth = new Set(minimumWidthPerSeed.map(String)).size <= 1;

    out.push({ workloadId, seeds: seedIds.length, successesByWidth, minimumWidthPerSeed, stableMinimumWidth, deterministicOutcome });
  }
  return out;
}

export function renderRepeatability(rows: readonly TaskRepeatability[]): string {
  const lines = ['Repeatability (successes / repetitions per width)', ''];
  lines.push(`${padEnd('task', 12)}${pad('w1', 7)}${pad('w2', 7)}${pad('w3', 7)}${pad('w4', 7)}${pad('minWidth/seed', 18)}${pad('stable', 8)}`);
  lines.push('-'.repeat(66));
  for (const r of rows) {
    const cell = (w: CrewWidth): string => {
      const c = r.successesByWidth[String(w)];
      return c ? `${c.successes}/${c.runs}` : '-';
    };
    lines.push(
      padEnd(r.workloadId, 12) + pad(cell(1), 7) + pad(cell(2), 7) + pad(cell(3), 7) + pad(cell(4), 7)
      + pad(r.minimumWidthPerSeed.map(m => m ?? 'x').join(','), 18)
      + pad(r.stableMinimumWidth ? 'yes' : 'NO', 8),
    );
  }
  const stable = rows.filter(r => r.stableMinimumWidth).length;
  lines.push('', `stable minimum width: ${stable}/${rows.length} task(s); fully deterministic outcomes: ${rows.filter(r => r.deterministicOutcome).length}/${rows.length}`);
  return lines.join('\n');
}

export function analyzeCrewScaling(records: readonly CrewScalingRecord[], source: string): CrewScalingAnalysis {
  return {
    generatedAt: new Date().toISOString(),
    source,
    runs: records.length,
    attemptedRuns: records.length,
    measuredRuns: records.filter(isMeasured).length,
    tasks: byTask(records).size,
    widths: aggregateByWidth(records),
    marginal: marginalSteps(records),
    dominance: dominanceSteps(records),
    minimumWidth: minimumWidths(records),
    oracle: oracleSavings(records),
  };
}

// ── Report ───────────────────────────────────────────────────────────

const pad = (v: string | number, n: number): string => String(v).padStart(n);
const padEnd = (v: string | number, n: number): string => String(v).padEnd(n);
const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const usd = (v: number): string => `$${v.toFixed(4)}`;
const pctStr = (v: number): string => `${v.toFixed(1)}%`;
const signed = (v: number, unit = '%'): string => `${v > 0 ? '+' : ''}${v.toFixed(1)}${unit}`;

export function renderCrewScalingReport(a: CrewScalingAnalysis): string {
  const lines: string[] = ['Crew-scaling characterization', ''];
  lines.push(`  source ${a.source}`);
  lines.push(`  ${a.attemptedRuns} run(s) attempted over ${a.tasks} task(s); ${a.measuredRuns} with resource measurements`);
  if (a.measuredRuns < a.attemptedRuns) {
    // Stated rather than inferred: success counts every attempt, averages
    // cannot count a run that never measured anything.
    lines.push(`  ${a.attemptedRuns - a.measuredRuns} run(s) ended before measuring; counted as failures, excluded from averages`);
  }

  lines.push('', 'Scaling curve  (success over attempts; averages over measured runs)');
  lines.push(`${padEnd('width', 7)}${pad('runs', 5)}${pad('measured', 10)}${pad('success', 9)}${pad('meanJCT', 9)}${pad('meanCost', 10)}${pad('tokens', 9)}${pad('modelCalls', 12)}${pad('toolCalls', 11)}${pad('active', 8)}${pad('activeFrac', 12)}`);
  lines.push('-'.repeat(102));
  for (const w of a.widths) {
    lines.push(
      padEnd(w.crewWidth, 7) + pad(w.attemptedRuns, 5)
      + pad(w.measuredRuns, 10)
      + pad(`${w.successes}/${w.attemptedRuns}`, 9)
      + pad(s(w.meanJctMs), 9) + pad(usd(w.meanCostUsd), 10)
      + pad(Math.round(w.meanTokens), 9) + pad(w.meanModelCalls.toFixed(1), 12)
      + pad(w.meanToolCalls.toFixed(1), 11) + pad(w.meanActiveAgents.toFixed(2), 8)
      + pad(pctStr(w.activeAgentFraction * 100), 12),
    );
  }

  lines.push('', 'Marginal returns (paired, same tasks)');
  for (const m of a.marginal) {
    lines.push(`  ${m.from} -> ${m.to}  (${m.pairedTasks} paired tasks; deltas over ${m.measuredPairs} measured pair(s))`);
    lines.push(`     outcome   +${m.newlySolved} newly solved, -${m.regressions} regressed, net ${m.netSolved >= 0 ? '+' : ''}${m.netSolved}`);
    lines.push(`     cost      ${signed(m.deltaCostUsd * 1000, ' m$')} total (${signed(m.deltaCostPct)})`);
    lines.push(`     latency   ${signed(m.deltaJctMs / 1000, 's')} mean (${signed(m.deltaJctPct)})`);
    lines.push(`     tokens    ${signed(m.deltaTokens, '')}   model calls ${signed(m.deltaModelCalls, '')}   tool calls ${signed(m.deltaToolCalls, '')}`);
    if (m.solvedPerDollar !== undefined) lines.push(`     yield     ${m.solvedPerDollar.toFixed(1)} extra solves per added dollar`);
  }

  lines.push('', 'Dominance (wider crew buys nothing and costs more)');
  for (const d of a.dominance) {
    lines.push(`  ${d.from} -> ${d.to}: ${d.dominated}/${d.comparablePairs} dominated (${pctStr(d.dominatedFraction * 100)}), same outcome cheaper at ${d.from}: ${d.sameOutcomeCheaper}`);
  }

  lines.push('', 'Minimum successful width');
  for (const w of WIDTHS) lines.push(`  first solved at width ${w}: ${a.minimumWidth.solvedAtWidth[String(w)] ?? 0}`);
  lines.push(`  never solved: ${a.minimumWidth.neverSolved}`);

  const o = a.oracle;
  lines.push('', `Oracle elastic bound (${o.tasksConsidered} tasks with a width-4 run)`);
  lines.push(`  always width 4: ${usd(o.alwaysWidestCostUsd)}, ${o.alwaysWidestTokens} tokens, ${s(o.alwaysWidestJctMs)} total, solved ${o.alwaysWidestSolved}`);
  lines.push(`  oracle minimum: ${usd(o.oracleCostUsd)}, ${o.oracleTokens} tokens, ${s(o.oracleJctMs)} total, solved ${o.oracleSolved}`);
  lines.push(`  saved: ${pctStr(o.costSavedPct)} cost, ${pctStr(o.tokensSavedPct)} tokens, JCT ${signed(o.jctChangePct)}`);
  return lines.join('\n');
}
