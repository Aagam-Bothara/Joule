/**
 * The staged-recovery comparison.
 *
 * Three arms over identical repositories and repetitions: the implementer
 * alone, the full crew every time, and the staged crew that escalates only
 * where verification fails. The question is whether staged keeps the full
 * crew's success while skipping the work the full crew does for nothing.
 *
 * Every "recovered" here is the verifier's judgement, from the stage reports —
 * a stage counts only if the external check passed after it ran.
 */

import { isMeasured } from '../crew-scaling/analyze.js';
import type { CrewScalingRecord } from '../crew-scaling/types.js';

const mean = (xs: readonly number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ratio = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
const pad = (v: unknown, n: number): string => String(v).padStart(n);
const padEnd = (v: unknown, n: number): string => String(v).padEnd(n);
const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;

/**
 * What one arm did.
 *
 * The funnel below is only meaningful for the staged arm: the other arms run
 * every agent by construction, so their invocation rates are 1 by definition
 * rather than by measurement.
 */
export interface ArmOutcome {
  arm: string;
  runs: number;
  successes: number;
  successRate: number;
  meanCostUsd: number;
  meanTokens: number;
  meanJctMs: number;
  /** Agents that actually executed, averaged */
  meanStagesExecuted: number;
  writesByRole: Record<string, { proposed: number; accepted: number; rolledBack: number }>;
}

export interface RecoveryFunnel {
  runs: number;
  primaryPassed: number;
  primaryFailed: number;
  reviewerInvoked: number;
  reviewerRecovered: number;
  testerInvoked: number;
  testerRecovered: number;
  /** Cumulative successes settled by each stage */
  successAfterPrimary: number;
  successAfterReviewer: number;
  successAfterTester: number;
  primarySuccessRate: number;
  reviewerInvocationRate: number;
  reviewerRecoveryRate: number;
  testerInvocationRate: number;
  testerRecoveryRate: number;
}

export function armOutcome(arm: string, records: readonly CrewScalingRecord[]): ArmOutcome {
  const writesByRole: ArmOutcome['writesByRole'] = {};
  for (const record of records) {
    for (const a of record.agentResults) {
      const role = a.role ?? a.agentId;
      const bucket = writesByRole[role] ?? (writesByRole[role] = { proposed: 0, accepted: 0, rolledBack: 0 });
      bucket.proposed += a.proposedWrites ?? 0;
      bucket.accepted += a.acceptedWrites ?? 0;
      bucket.rolledBack += a.rolledBackWrites ?? 0;
    }
  }
  const measured = records.filter(isMeasured);
  const successes = records.filter(r => r.success).length;
  return {
    arm,
    runs: records.length,
    successes,
    successRate: ratio(successes, records.length),
    meanCostUsd: mean(measured.map(r => r.totalCostUsd)),
    meanTokens: mean(measured.map(r => r.totalTokens)),
    meanJctMs: mean(measured.map(r => r.workflowJctMs)),
    // A staged run reports the stages it executed; the other arms run everyone.
    meanStagesExecuted: mean(records.map(r => r.staged?.stagesExecuted ?? r.agentResults.length)),
    writesByRole,
  };
}

export function recoveryFunnel(records: readonly CrewScalingRecord[]): RecoveryFunnel {
  let primaryPassed = 0;
  let reviewerInvoked = 0;
  let reviewerRecovered = 0;
  let testerInvoked = 0;
  let testerRecovered = 0;

  for (const record of records) {
    const stages = record.staged?.stages ?? [];
    const solved = record.staged?.solvedAtStage;
    if (solved === 1) primaryPassed++;
    if (stages[1]?.executed) {
      reviewerInvoked++;
      if (solved === 2) reviewerRecovered++;
    }
    if (stages[2]?.executed) {
      testerInvoked++;
      if (solved === 3) testerRecovered++;
    }
  }

  const runs = records.length;
  return {
    runs,
    primaryPassed,
    primaryFailed: runs - primaryPassed,
    reviewerInvoked,
    reviewerRecovered,
    testerInvoked,
    testerRecovered,
    successAfterPrimary: primaryPassed,
    successAfterReviewer: primaryPassed + reviewerRecovered,
    successAfterTester: primaryPassed + reviewerRecovered + testerRecovered,
    primarySuccessRate: ratio(primaryPassed, runs),
    reviewerInvocationRate: ratio(reviewerInvoked, runs),
    reviewerRecoveryRate: ratio(reviewerRecovered, reviewerInvoked),
    testerInvocationRate: ratio(testerInvoked, runs),
    testerRecoveryRate: ratio(testerRecovered, testerInvoked),
  };
}

export interface StagedComparison {
  generatedAt: string;
  arms: ArmOutcome[];
  funnel?: RecoveryFunnel;
  /** Staged against full, on the measures the strategy is meant to move */
  savings?: {
    successDelta: number;
    costReductionPct: number;
    tokenReductionPct: number;
    jctReductionPct: number;
  };
}

export function compareStaged(
  byArm: ReadonlyArray<{ arm: string; records: readonly CrewScalingRecord[] }>,
): StagedComparison {
  const arms = byArm.map(a => armOutcome(a.arm, a.records));
  const stagedRecords = byArm.find(a => a.arm === 'staged');
  const full = arms.find(a => a.arm === 'full');
  const staged = arms.find(a => a.arm === 'staged');
  const drop = (from: number, to: number): number => (from > 0 ? ((from - to) / from) * 100 : 0);

  return {
    generatedAt: new Date().toISOString(),
    arms,
    ...(stagedRecords ? { funnel: recoveryFunnel(stagedRecords.records) } : {}),
    ...(full && staged ? {
      savings: {
        successDelta: staged.successRate - full.successRate,
        costReductionPct: drop(full.meanCostUsd, staged.meanCostUsd),
        tokenReductionPct: drop(full.meanTokens, staged.meanTokens),
        jctReductionPct: drop(full.meanJctMs, staged.meanJctMs),
      },
    } : {}),
  };
}

export function renderStagedComparison(c: StagedComparison): string {
  const lines = ['Staged recovery comparison', ''];
  lines.push(padEnd('arm', 12) + pad('success', 10) + pad('cost', 10) + pad('tokens', 9) + pad('JCT', 8) + pad('stages', 8));
  lines.push('-'.repeat(57));
  for (const a of c.arms) {
    lines.push(
      padEnd(a.arm, 12)
      + pad(`${a.successes}/${a.runs}`, 10)
      + pad(`$${a.meanCostUsd.toFixed(4)}`, 10)
      + pad(Math.round(a.meanTokens), 9)
      + pad(`${(a.meanJctMs / 1000).toFixed(0)}s`, 8)
      + pad(a.meanStagesExecuted.toFixed(2), 8),
    );
  }

  const f = c.funnel;
  if (f) {
    lines.push('', 'Recovery funnel (staged)');
    lines.push(`  primary passed:     ${f.primaryPassed}/${f.runs} (${pct(f.primarySuccessRate)})`);
    lines.push(`  primary failed:     ${f.primaryFailed}`);
    lines.push(`  reviewer invoked:   ${f.reviewerInvoked} (${pct(f.reviewerInvocationRate)} of runs)`);
    lines.push(`  reviewer recovered: ${f.reviewerRecovered} (${pct(f.reviewerRecoveryRate)} of invocations)`);
    lines.push(`  tester invoked:     ${f.testerInvoked} (${pct(f.testerInvocationRate)} of runs)`);
    lines.push(`  tester recovered:   ${f.testerRecovered} (${pct(f.testerRecoveryRate)} of invocations)`);
    lines.push(`  success after primary / reviewer / tester: ${f.successAfterPrimary} / ${f.successAfterReviewer} / ${f.successAfterTester}`);
  }

  const s = c.savings;
  if (s) {
    const signed = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}`;
    lines.push('', 'Staged against full');
    lines.push(
      `  success ${signed(s.successDelta * 100)}pp   cost ${signed(-s.costReductionPct)}%   `
      + `tokens ${signed(-s.tokenReductionPct)}%   JCT ${signed(-s.jctReductionPct)}%`,
    );
  }

  lines.push('', 'Writes by role (proposed / accepted / rolled back)');
  for (const a of c.arms) {
    const roles = Object.entries(a.writesByRole).sort();
    if (roles.length === 0) continue;
    lines.push(`  ${a.arm}`);
    for (const [role, w] of roles) {
      lines.push(`    ${padEnd(role, 14)}${w.proposed} / ${w.accepted} / ${w.rolledBack}`);
    }
  }

  return lines.join('\n');
}
