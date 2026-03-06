/**
 * RewardEngine — Behavioral feedback loop for agent trust.
 *
 * Translates task outcomes into trust score adjustments:
 *  - Rewards: success, under-budget, clean streaks, self-reporting
 *  - Punishments: violations, budget overuse, repeated failures
 *
 * Punishment severity escalates with violation history:
 *  - warning:     -0.05 (first offense)
 *  - strike:      -0.15 (repeated offenses)
 *  - suspension:  -0.40 (serious pattern)
 *  - termination: → 0.0 (irreversible)
 */

import {
  type TrustAdjustment,
  type ViolationRecord,
  type ViolationSeverity,
  type TaskOutcomeForReward,
  type RewardType,
  type PunishmentType,
  isoNow,
} from '@joule/shared';
import type { TrustManager } from './trust-manager.js';

// ── Reward/Punishment amounts ───────────────────────────────────────

const REWARDS = {
  task_success: 0.02,
  under_budget: 0.01,
  clean_streak: 0.05,       // bonus at 5 clean tasks
  self_report: 0.03,
} as const;

const PUNISHMENTS: Record<ViolationSeverity, number> = {
  warning: -0.05,
  strike: -0.15,
  suspension: -0.40,
  termination: -Infinity,    // sets to 0
};

const CLEAN_STREAK_THRESHOLD = 5;

// ── Main class ──────────────────────────────────────────────────────

export class RewardEngine {
  private trustManager: TrustManager;

  constructor(trustManager: TrustManager) {
    this.trustManager = trustManager;
  }

  /**
   * Evaluate a task outcome and apply the appropriate trust adjustment.
   * Returns the combined adjustment applied.
   */
  evaluateTaskOutcome(agentId: string, outcome: TaskOutcomeForReward): TrustAdjustment {
    const profile = this.trustManager.getProfile(agentId);

    // Handle violations first (punishments take priority)
    if (outcome.violations.length > 0) {
      const severity = this.getSeverity(outcome.violations, profile.violationHistory);

      // Record each violation
      for (const v of outcome.violations) {
        this.trustManager.recordViolation(agentId, v);
      }

      if (severity === 'termination') {
        // Terminal: set to 0
        const delta = -profile.trustScore;
        return this.trustManager.updateScore(agentId, delta, 'violation');
      }

      const punishment = PUNISHMENTS[severity];
      this.trustManager.recordTaskFailure(agentId);
      return this.trustManager.updateScore(agentId, punishment, 'violation');
    }

    // No violations — calculate rewards
    let totalDelta = 0;
    let bestReason: RewardType | PunishmentType = 'task_success';
    let bestReasonDelta = 0;

    if (outcome.success) {
      totalDelta += REWARDS.task_success;
      bestReasonDelta = REWARDS.task_success;
      this.trustManager.recordTaskSuccess(agentId);

      if (outcome.underBudget) {
        totalDelta += REWARDS.under_budget;
        if (REWARDS.under_budget > bestReasonDelta) {
          bestReason = 'under_budget';
          bestReasonDelta = REWARDS.under_budget;
        }
      }

      // Check for clean streak bonus
      const newProfile = this.trustManager.getProfile(agentId);
      if (newProfile.streaks.clean > 0 && newProfile.streaks.clean % CLEAN_STREAK_THRESHOLD === 0) {
        totalDelta += REWARDS.clean_streak;
        if (REWARDS.clean_streak > bestReasonDelta) {
          bestReason = 'clean_streak';
          bestReasonDelta = REWARDS.clean_streak;
        }
      }
    } else {
      this.trustManager.recordTaskFailure(agentId);
      // Failure without violations: small penalty
      totalDelta = -0.01;
      bestReason = 'repeated_failure';
      bestReasonDelta = 0.01;
    }

    if (outcome.selfReported) {
      totalDelta += REWARDS.self_report;
      if (REWARDS.self_report > bestReasonDelta) {
        bestReason = 'self_report';
      }
    }

    return this.trustManager.updateScore(agentId, totalDelta, bestReason);
  }

  /**
   * Determine violation severity based on current + historical violations.
   * Escalates with repeated offenses.
   */
  getSeverity(
    currentViolations: ViolationRecord[],
    history: ViolationRecord[],
  ): ViolationSeverity {
    const hasTermination = currentViolations.some(v => v.severity === 'termination');
    if (hasTermination) return 'termination';

    const hasSuspension = currentViolations.some(v => v.severity === 'suspension');
    if (hasSuspension) return 'suspension';

    // Count recent violations (last 10 in history + current)
    const recentCount = history.slice(-10).length + currentViolations.length;

    if (recentCount >= 8) return 'suspension';
    if (recentCount >= 4) return 'strike';
    return 'warning';
  }
}
