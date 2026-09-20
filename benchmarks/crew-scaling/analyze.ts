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
    return [{
      crewWidth: width,
      runs: rs.length,
      successes: rs.filter(r => r.success).length,
      successRate: rs.filter(r => r.success).length / rs.length,
      meanJctMs: mean(rs.map(r => r.workflowJctMs)),
      medianJctMs: percentile(rs.map(r => r.workflowJctMs), 0.5),
      meanCostUsd: mean(rs.map(r => r.totalCostUsd)),
      medianCostUsd: percentile(rs.map(r => r.totalCostUsd), 0.5),
      meanTokens: mean(rs.map(r => r.totalTokens)),
      meanModelCalls: mean(rs.map(r => r.modelCalls)),
      meanToolCalls: mean(rs.map(r => r.toolCalls)),
      meanActiveAgents: mean(rs.map(r => r.activeAgents)),
      activeAgentFraction: mean(rs.map(r => r.activeAgents / r.crewWidth)),
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
    const deltaCostUsd = sum(ps.map(p => p.to.totalCostUsd - p.from.totalCostUsd));
    const fromCost = sum(ps.map(p => p.from.totalCostUsd));
    const deltaTokens = sum(ps.map(p => p.to.totalTokens - p.from.totalTokens));
    const deltaJctMs = mean(ps.map(p => p.to.workflowJctMs - p.from.workflowJctMs));
    const fromJct = mean(ps.map(p => p.from.workflowJctMs));

    steps.push({
      from,
      to,
      pairedTasks: ps.length,
      newlySolved,
      regressions,
      netSolved,
      deltaCostUsd,
      deltaCostPct: fromCost > 0 ? (deltaCostUsd / fromCost) * 100 : 0,
      deltaJctMs,
      deltaJctPct: fromJct > 0 ? (deltaJctMs / fromJct) * 100 : 0,
      deltaTokens,
      deltaModelCalls: sum(ps.map(p => p.to.modelCalls - p.from.modelCalls)),
      deltaToolCalls: sum(ps.map(p => p.to.toolCalls - p.from.toolCalls)),
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
    // Dominated: no better outcome, more money, and no better latency.
    const dominated = ps.filter(p =>
      Number(p.to.success) <= Number(p.from.success)
      && p.to.totalCostUsd > p.from.totalCostUsd
      && p.to.workflowJctMs >= p.from.workflowJctMs).length;
    const sameOutcomeCheaper = ps.filter(p => p.to.success === p.from.success && p.from.totalCostUsd < p.to.totalCostUsd).length;
    steps.push({ from, to, pairedTasks: ps.length, dominated, dominatedFraction: dominated / ps.length, sameOutcomeCheaper });
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
    if (!widestRun) continue;
    tasksConsidered++;
    alwaysWidestCostUsd += widestRun.totalCostUsd;
    alwaysWidestTokens += widestRun.totalTokens;
    alwaysWidestJctMs += widestRun.workflowJctMs;
    if (widestRun.success) alwaysWidestSolved++;

    const minWidth = WIDTHS.find(w => perWidth.get(w)?.success);
    const chosen = minWidth ? perWidth.get(minWidth)! : widestRun;
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

export function analyzeCrewScaling(records: readonly CrewScalingRecord[], source: string): CrewScalingAnalysis {
  return {
    generatedAt: new Date().toISOString(),
    source,
    runs: records.length,
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
  lines.push(`  ${a.runs} run(s) over ${a.tasks} task(s)`);

  lines.push('', 'Scaling curve');
  lines.push(`${padEnd('width', 7)}${pad('runs', 5)}${pad('success', 9)}${pad('meanJCT', 9)}${pad('meanCost', 10)}${pad('tokens', 9)}${pad('modelCalls', 12)}${pad('toolCalls', 11)}${pad('active', 8)}${pad('activeFrac', 12)}`);
  lines.push('-'.repeat(92));
  for (const w of a.widths) {
    lines.push(
      padEnd(w.crewWidth, 7) + pad(w.runs, 5)
      + pad(`${w.successes}/${w.runs}`, 9)
      + pad(s(w.meanJctMs), 9) + pad(usd(w.meanCostUsd), 10)
      + pad(Math.round(w.meanTokens), 9) + pad(w.meanModelCalls.toFixed(1), 12)
      + pad(w.meanToolCalls.toFixed(1), 11) + pad(w.meanActiveAgents.toFixed(2), 8)
      + pad(pctStr(w.activeAgentFraction * 100), 12),
    );
  }

  lines.push('', 'Marginal returns (paired, same tasks)');
  for (const m of a.marginal) {
    lines.push(`  ${m.from} -> ${m.to}  (${m.pairedTasks} paired tasks)`);
    lines.push(`     outcome   +${m.newlySolved} newly solved, -${m.regressions} regressed, net ${m.netSolved >= 0 ? '+' : ''}${m.netSolved}`);
    lines.push(`     cost      ${signed(m.deltaCostUsd * 1000, ' m$')} total (${signed(m.deltaCostPct)})`);
    lines.push(`     latency   ${signed(m.deltaJctMs / 1000, 's')} mean (${signed(m.deltaJctPct)})`);
    lines.push(`     tokens    ${signed(m.deltaTokens, '')}   model calls ${signed(m.deltaModelCalls, '')}   tool calls ${signed(m.deltaToolCalls, '')}`);
    if (m.solvedPerDollar !== undefined) lines.push(`     yield     ${m.solvedPerDollar.toFixed(1)} extra solves per added dollar`);
  }

  lines.push('', 'Dominance (wider crew buys nothing and costs more)');
  for (const d of a.dominance) {
    lines.push(`  ${d.from} -> ${d.to}: ${d.dominated}/${d.pairedTasks} dominated (${pctStr(d.dominatedFraction * 100)}), same outcome cheaper at ${d.from}: ${d.sameOutcomeCheaper}`);
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
