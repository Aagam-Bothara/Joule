import type { EscalationMetrics, StrategyName, TaskReport } from '../types.js';

/**
 * Routing quality needs ground truth, and only counterfactual runs provide it.
 * With a stochastic small model one slm-only run is a noisy label, so slm-only
 * may be repeated: pSlm(task) = fraction of slm-only runs that succeeded.
 *
 *   needed(task)    = pSlm < 0.5 AND llm-only succeeded
 *   escalated(task) = the strategy spent LLM-tier tokens on the task
 *
 *   precision      = |escalated ∧ needed| / |escalated|
 *   soft precision = mean over escalated tasks of (1 − pSlm)
 *   wasted         = escalations on tasks with pSlm ≥ 0.8
 *   recall         = |escalated ∧ needed| / |needed|
 */
export function pSlmByTask(reports: TaskReport[]): Map<string, number> {
  const runs = new Map<string, TaskReport[]>();
  for (const r of reports.filter(r => r.strategy === 'slm-only')) {
    runs.set(r.workloadId, [...(runs.get(r.workloadId) ?? []), r]);
  }
  return new Map([...runs].map(([id, rs]) => [id, rs.filter(r => r.success).length / rs.length]));
}

export function computeEscalationMetrics(reports: TaskReport[]): EscalationMetrics[] {
  const pSlm = pSlmByTask(reports);
  const llm = new Map(reports.filter(r => r.strategy === 'llm-only').map(r => [r.workloadId, r]));
  if (pSlm.size === 0 || llm.size === 0) return [];

  const strategies = [...new Set(reports.map(r => r.strategy))].filter(s => s !== 'slm-only' && s !== 'llm-only');
  const out: EscalationMetrics[] = [];

  for (const strategy of strategies) {
    const runs = reports.filter(r => r.strategy === strategy && r.repeat === undefined);
    let escalated = 0, needed = 0, tp = 0, wasted = 0, softSum = 0;
    let consulted = 0, consultOk = 0, handedOff = 0, handoffOk = 0;
    let cost = 0, llmCost = 0, ok = 0, n = 0;

    for (const r of runs) {
      const p = pSlm.get(r.workloadId);
      const l = llm.get(r.workloadId);
      if (p === undefined || !l) continue;
      n++;
      const wasNeeded = p < 0.5 && l.success;
      if (wasNeeded) needed++;
      if (r.llmUsed) {
        escalated++;
        softSum += 1 - p;
        if (wasNeeded) tp++;
        if (p >= 0.8) wasted++;
      }
      if (r.consultations > 0) { consulted++; if (r.success && r.handoffs === 0) consultOk++; }
      if (r.handoffs > 0) { handedOff++; if (r.success) handoffOk++; }
      if (r.success) ok++;
      cost += r.cost;
      llmCost += l.cost;
    }

    const rate = (a: number, b: number) => (b > 0 ? a / b : null);
    out.push({
      strategy: strategy as StrategyName,
      escalated,
      needed,
      truePositives: tp,
      precision: rate(tp, escalated),
      softPrecision: rate(softSum, escalated),
      wasted,
      recall: rate(tp, needed),
      consultSuccessRate: rate(consultOk, consulted),
      handoffSuccessRate: rate(handoffOk, handedOff),
      costRatioVsLlmOnly: llmCost > 0 ? cost / llmCost : null,
      successRate: n > 0 ? ok / n : 0,
    });
  }
  return out;
}
