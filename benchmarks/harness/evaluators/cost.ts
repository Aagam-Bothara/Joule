import type { StrategyName, StrategySummary, TaskReport } from '../types.js';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Per-strategy economics and runtime rollup. */
export function summarizeStrategy(strategy: StrategyName, reports: TaskReport[]): StrategySummary {
  const rs = reports.filter(r => r.strategy === strategy);
  return {
    strategy,
    tasks: rs.length,
    successRate: rs.length ? rs.filter(r => r.success).length / rs.length : 0,
    avgCost: avg(rs.map(r => r.cost)),
    totalCost: rs.reduce((a, r) => a + r.cost, 0),
    avgGateCost: avg(rs.map(r => r.gateCost)),
    avgLatencyMs: avg(rs.map(r => r.latencyMs)),
    avgSlmTokens: avg(rs.map(r => r.slmTokens)),
    avgLlmTokens: avg(rs.map(r => r.llmTokens)),
    avgToolCalls: avg(rs.map(r => r.toolCalls)),
    llmUsedRate: rs.length ? rs.filter(r => r.llmUsed).length / rs.length : 0,
    consultations: rs.reduce((a, r) => a + r.consultations, 0),
    handoffs: rs.reduce((a, r) => a + r.handoffs, 0),
  };
}
