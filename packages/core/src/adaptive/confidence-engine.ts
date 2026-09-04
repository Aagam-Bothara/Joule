/**
 * ConfidenceEngine — evidence-based confidence for the escalation policy.
 *
 * Deliberately excludes any model self-report. Every input is observable:
 * tool results, deterministic verification, progress, repeated failures,
 * contradictions and budget headroom.
 *
 *   composite =
 *       w.tool     * toolSuccess
 *     + w.verify   * verification
 *     + w.progress * progress
 *     + w.budget   * budgetHeadroom
 *     + w.clean    * (1 - repeatedFailure)
 *     - w.repeat   * repeatedFailure
 *     - w.contra   * contradiction
 */

import type { BudgetUsage, Confidence, ExecutionState } from '@joule/shared';
import { maxRepeatedFailure } from './execution-state.js';

export interface ConfidenceWeights {
  tool: number;
  verify: number;
  progress: number;
  budget: number;
  clean: number;
  repeat: number;
  contra: number;
}

const DEFAULT_WEIGHTS: ConfidenceWeights = {
  tool: 0.30,
  verify: 0.25,
  progress: 0.25,
  budget: 0.10,
  clean: 0.10,
  repeat: 0.20,
  contra: 0.20,
};

/** Recent-window size for the progress signal. */
const PROGRESS_WINDOW = 5;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export class ConfidenceEngine {
  private readonly w: ConfidenceWeights;

  constructor(weights?: Partial<ConfidenceWeights>) {
    this.w = { ...DEFAULT_WEIGHTS, ...weights };
  }

  compute(state: ExecutionState, budget: BudgetUsage): Confidence {
    const steps = state.completedSteps;
    const last = steps[steps.length - 1];

    // Tool success: outcome of the most recent action.
    const toolSuccess = last ? (last.success ? 1 : 0) : 0.5;

    // Verification: deterministic verifier result on the most recent step.
    const verification = last
      ? (last.verified === true ? 1 : last.verified === false ? 0 : 0.5)
      : 0.5;

    // Progress: share of the recent window that produced verified, successful work.
    // Missing window slots count as neutral (0.5) so a single early failure is
    // not read as "no progress at all".
    const window = steps.slice(-PROGRESS_WINDOW);
    // A failed verification that passes more checks than the previous attempt is progress too.
    const good = window.filter((s, i) => {
      if (s.success && s.verified !== false) return true;
      const prev = i > 0 ? window[i - 1] : steps[steps.length - window.length - 1];
      return s.verified === false && s.verifyScore !== undefined && prev?.verifyScore !== undefined && s.verifyScore > prev.verifyScore;
    }).length;
    const progress = (good + 0.5 * (PROGRESS_WINDOW - window.length)) / PROGRESS_WINDOW;

    // Repeated failure: same signature seen more than once.
    const repeats = maxRepeatedFailure(state);
    const repeatedFailure = repeats <= 1 ? 0 : repeats === 2 ? 0.5 : 1;

    // Contradiction: the tool said success but verification disagreed.
    const contradiction = last && last.success && last.verified === false ? 1 : 0;

    // Budget headroom: the tighter of cost and tokens, as a fraction of the ceiling.
    const costTotal = budget.costUsd + budget.costRemaining;
    const tokenTotal = budget.tokensUsed + budget.tokensRemaining;
    const costHeadroom = costTotal > 0 ? budget.costRemaining / costTotal : 1;
    const tokenHeadroom = Number.isFinite(tokenTotal) && tokenTotal > 0 ? budget.tokensRemaining / tokenTotal : 1;
    const budgetHeadroom = clamp01(Math.min(costHeadroom, tokenHeadroom));

    const composite = clamp01(
      this.w.tool * toolSuccess
      + this.w.verify * verification
      + this.w.progress * progress
      + this.w.budget * budgetHeadroom
      + this.w.clean * (1 - repeatedFailure)
      - this.w.repeat * repeatedFailure
      - this.w.contra * contradiction,
    );

    return {
      composite: round(composite),
      toolSuccess,
      verification,
      progress: round(progress),
      repeatedFailure,
      contradiction,
      budgetHeadroom: round(budgetHeadroom),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
