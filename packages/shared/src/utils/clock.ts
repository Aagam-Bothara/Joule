import { performance } from 'node:perf_hooks';

export function monotonicNow(): number {
  return performance.now();
}

export function isoNow(): string {
  return new Date().toISOString();
}
