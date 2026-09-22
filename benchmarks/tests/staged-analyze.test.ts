import { describe, it, expect } from 'vitest';
import { armOutcome, compareStaged, recoveryFunnel, renderStagedComparison } from '../specialist-value/staged-analyze.js';
import { comparisonCrew, COMPARISON_ARMS } from '../specialist-value/crews.js';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import type { StageReport } from '@joule/shared';

/** A staged record: which stages ran, and which one the verifier settled it at. */
function staged(o: {
  workloadId?: string;
  seed?: number;
  success: boolean;
  /** How many stages executed; the rest are reported as skipped */
  executed: number;
  solvedAtStage?: number;
  costUsd?: number;
  tokens?: number;
  jctMs?: number;
}): CrewScalingRecord {
  const roles = ['Implementer', 'Reviewer', 'Tester'];
  const stages: StageReport[] = roles.map((role, i) => (i < o.executed
    ? {
      stage: i + 1, agentId: role.toLowerCase(), role, executed: true,
      status: 'completed', modelCalls: 3, toolCalls: 2,
      verification: { passed: o.solvedAtStage === i + 1, output: 'checked' },
    }
    : { stage: i + 1, agentId: role.toLowerCase(), role, executed: false, skipReason: 'verification_already_passed' }));

  return {
    runId: 'r', taskId: 't', workloadId: o.workloadId ?? 'f-edge-case',
    crewWidth: 1, roles: roles.slice(0, o.executed).map(r => r.toLowerCase()),
    seed: o.seed ?? 0,
    success: o.success,
    workflowJctMs: o.jctMs ?? 60_000,
    totalCostUsd: o.costUsd ?? 0.005,
    totalTokens: o.tokens ?? 20_000,
    modelCalls: 3 * o.executed, toolCalls: 2 * o.executed,
    modelRuntimeMs: 1000, toolWaitMs: 100,
    activeAgents: o.executed,
    gateEnabled: true,
    staged: {
      stagesExecuted: o.executed,
      ...(o.solvedAtStage ? { solvedAtStage: o.solvedAtStage, solvedByRole: roles[o.solvedAtStage - 1] } : {}),
      verified: o.solvedAtStage !== undefined,
      stages,
    },
    agentResults: roles.slice(0, o.executed).map(role => ({
      agentId: role.toLowerCase(), role, success: true, status: 'completed',
      modelCalls: 3, toolCalls: 2,
      proposedWrites: role === 'Implementer' ? 1 : 0,
      acceptedWrites: role === 'Implementer' ? 1 : 0,
      rolledBackWrites: 0,
    })),
  };
}

/** A non-staged record: every agent ran, no stage report. */
function full(o: { success: boolean; costUsd?: number; tokens?: number; jctMs?: number }): CrewScalingRecord {
  const base = staged({ ...o, executed: 3 });
  const { staged: _dropped, ...rest } = base;
  return rest as CrewScalingRecord;
}

describe('staged recovery comparison', () => {
  it('counts executed stages, not crew size', () => {
    const out = armOutcome('staged', [
      staged({ success: true, executed: 1, solvedAtStage: 1 }),
      staged({ success: true, executed: 2, solvedAtStage: 2 }),
      staged({ success: false, executed: 3 }),
    ]);

    expect(out.runs).toBe(3);
    expect(out.successes).toBe(2);
    expect(out.meanStagesExecuted).toBeCloseTo(2, 6);
  });

  it('falls back to the agents that ran when there is no stage report', () => {
    const out = armOutcome('full', [full({ success: true }), full({ success: false })]);
    expect(out.meanStagesExecuted).toBe(3);
    expect(out.successRate).toBe(0.5);
  });

  it('builds the escalation funnel from the verifier, not from the agents', () => {
    const f = recoveryFunnel([
      staged({ success: true, executed: 1, solvedAtStage: 1 }),
      staged({ success: true, executed: 1, solvedAtStage: 1 }),
      staged({ success: true, executed: 2, solvedAtStage: 2 }),
      staged({ success: false, executed: 3 }),
    ]);

    expect(f.primaryPassed).toBe(2);
    expect(f.primaryFailed).toBe(2);
    // Only the two runs whose primary failed went on to a reviewer.
    expect(f.reviewerInvoked).toBe(2);
    expect(f.reviewerRecovered).toBe(1);
    expect(f.reviewerRecoveryRate).toBeCloseTo(0.5, 6);
    expect(f.testerInvoked).toBe(1);
    expect(f.testerRecovered).toBe(0);
    expect(f.successAfterPrimary).toBe(2);
    expect(f.successAfterReviewer).toBe(3);
    expect(f.successAfterTester).toBe(3);
  });

  it('measures staged against full on the things it is meant to move', () => {
    const comparison = compareStaged([
      { arm: 'primary', records: [full({ success: false, costUsd: 0.002, tokens: 8000, jctMs: 30_000 })] },
      { arm: 'full', records: [full({ success: true, costUsd: 0.010, tokens: 40_000, jctMs: 120_000 })] },
      { arm: 'staged', records: [staged({ success: true, executed: 1, solvedAtStage: 1, costUsd: 0.005, tokens: 20_000, jctMs: 60_000 })] },
    ]);

    expect(comparison.savings?.successDelta).toBe(0);
    expect(comparison.savings?.costReductionPct).toBeCloseTo(50, 6);
    expect(comparison.savings?.tokenReductionPct).toBeCloseTo(50, 6);
    expect(comparison.savings?.jctReductionPct).toBeCloseTo(50, 6);

    const report = renderStagedComparison(comparison);
    expect(report).toContain('Recovery funnel (staged)');
    expect(report).toContain('Writes by role');
    expect(report).toContain('Staged against full');
  });

  it('gives the three arms the same agents and differs only in strategy', () => {
    const [primary, fullCrew, stagedCrew] = COMPARISON_ARMS.map(comparisonCrew);

    expect(primary.strategy).toBe('sequential');
    expect(fullCrew.strategy).toBe('sequential');
    expect(stagedCrew.strategy).toBe('staged_recovery');
    // Full and staged are the same crew run two ways.
    expect(stagedCrew.agents).toEqual(fullCrew.agents);
    expect(primary.agents).toEqual([fullCrew.agents[0]]);
    // The recovery contracts are repository-generic.
    for (const agent of stagedCrew.agents) {
      expect(agent.instructions).not.toContain('solution.py');
      expect(agent.allowedTools).toContain('file_write');
    }
    expect(stagedCrew.agents[1].instructions).toContain('external verification');
    expect(stagedCrew.agents[2].instructions).toContain('isolate the remaining defect');
  });
});
