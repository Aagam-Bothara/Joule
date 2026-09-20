/**
 * Comparison and rendering for simulation results.
 *
 * Improvements are always stated against the `observed` baseline replayed under
 * the same capacities, so a policy is never credited for a capacity change.
 */

import type { PolicyComparison, SimMetrics } from './types.js';

const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number): string => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const pad = (v: string | number, n: number): string => String(v).padStart(n);
const padEnd = (v: string | number, n: number): string => String(v).padEnd(n);

/** Percentage change, guarding the zero-baseline case. */
function change(baseline: number, value: number): number {
  if (baseline === 0) return value === 0 ? 0 : 100;
  return ((value - baseline) / baseline) * 100;
}

export function compare(baseline: SimMetrics, policy: SimMetrics): PolicyComparison {
  return {
    policy: policy.policy,
    deltaMeanJctPct: change(baseline.meanJctMs, policy.meanJctMs),
    deltaP95JctPct: change(baseline.p95JctMs, policy.p95JctMs),
    deltaMakespanPct: change(baseline.makespanMs, policy.makespanMs),
    deltaZeroModelDemandPct: change(baseline.zeroModelDemandMs, policy.zeroModelDemandMs),
    deltaSyncToolWaitPct: change(baseline.synchronizedToolWaitFraction, policy.synchronizedToolWaitFraction),
    deltaMeanJctMs: policy.meanJctMs - baseline.meanJctMs,
    deltaMakespanMs: policy.makespanMs - baseline.makespanMs,
  };
}

export function renderPolicyTable(results: readonly SimMetrics[]): string {
  const lines = [
    `${padEnd('policy', 13)}${pad('meanJCT', 9)}${pad('medJCT', 9)}${pad('p95JCT', 9)}${pad('makespan', 10)}${pad('modelUtil', 10)}${pad('avgModel', 9)}${pad('zeroModel', 10)}${pad('syncTool', 9)}${pad('allTool', 8)}${pad('mQp95', 8)}${pad('tQp95', 8)}`,
    '-'.repeat(112),
  ];
  for (const r of results) {
    lines.push(
      padEnd(r.policy, 13)
      + pad(s(r.meanJctMs), 9) + pad(s(r.medianJctMs), 9) + pad(s(r.p95JctMs), 9) + pad(s(r.makespanMs), 10)
      + pad(pct(r.modelUtilization), 10) + pad(r.avgModelDemand.toFixed(2), 9)
      + pad(pct(r.zeroModelDemandFraction), 10) + pad(pct(r.synchronizedToolWaitFraction), 9)
      + pad(pct(r.allAgentsToolWaitFraction), 8)
      + pad(s(r.modelQueue.p95Ms), 8) + pad(s(r.toolQueue.p95Ms), 8),
    );
  }
  return lines.join('\n');
}

export function renderImprovements(baseline: SimMetrics, results: readonly SimMetrics[]): string {
  const lines = [
    `${padEnd('vs baseline', 13)}${pad('meanJCT', 10)}${pad('p95JCT', 10)}${pad('makespan', 10)}${pad('zeroModel', 11)}${pad('syncTool', 10)}`,
    '-'.repeat(64),
  ];
  for (const r of results) {
    if (r.policy === baseline.policy) continue;
    const c = compare(baseline, r);
    lines.push(
      padEnd(r.policy, 13)
      + pad(signed(c.deltaMeanJctPct), 10) + pad(signed(c.deltaP95JctPct), 10)
      + pad(signed(c.deltaMakespanPct), 10) + pad(signed(c.deltaZeroModelDemandPct), 11)
      + pad(signed(c.deltaSyncToolWaitPct), 10),
    );
  }
  lines.push('(negative is better for every column)');
  return lines.join('\n');
}

export function renderSweep(rows: readonly { modelCapacity: number; toolCapacity: number; baseline: SimMetrics; best: SimMetrics; oracle: SimMetrics }[]): string {
  const lines = [
    `${pad('model', 6)}${pad('tool', 6)}${pad('baseMakespan', 14)}${pad('oracleMakespan', 16)}${pad('oracleΔ', 10)}${pad('oracleΔmeanJCT', 16)}${pad('bestPolicy', 14)}${pad('bestΔ', 9)}`,
    '-'.repeat(92),
  ];
  for (const r of rows) {
    const oc = compare(r.baseline, r.oracle);
    const bc = compare(r.baseline, r.best);
    lines.push(
      pad(r.modelCapacity, 6) + pad(r.toolCapacity, 6)
      + pad(s(r.baseline.makespanMs), 14) + pad(s(r.oracle.makespanMs), 16)
      + pad(signed(oc.deltaMakespanPct), 10) + pad(signed(oc.deltaMeanJctPct), 16)
      + pad(r.best.policy, 14) + pad(signed(bc.deltaMakespanPct), 9),
    );
  }
  return lines.join('\n');
}
