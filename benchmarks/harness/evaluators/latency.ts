import type { TaskReport } from '../types.js';

export interface LatencyStats { avgMs: number; p50Ms: number; p95Ms: number; maxMs: number }

export function latencyStats(reports: TaskReport[]): LatencyStats {
  const xs = reports.map(r => r.latencyMs).sort((a, b) => a - b);
  if (xs.length === 0) return { avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const pick = (p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return {
    avgMs: xs.reduce((a, b) => a + b, 0) / xs.length,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: xs[xs.length - 1],
  };
}
