import type { TaskResult } from '@joule/shared';
import type { Workload } from '../types.js';

/**
 * Success is deterministic when the workload declares a verifier; otherwise it
 * is the task status, and the report says so. Never mix the two in one number.
 */
export function evaluateSuccess(result: TaskResult, workload: Workload): { success: boolean; verifierKind: 'deterministic' | 'status' } {
  if (workload.verify) {
    let ok = false;
    try { ok = workload.verify(result); } catch { ok = false; }
    return { success: ok && result.status === 'completed', verifierKind: 'deterministic' };
  }
  return { success: result.status === 'completed', verifierKind: 'status' };
}
