/**
 * AdaptiveController
 *
 * Makes online energy-quality tradeoff decisions based on runtime execution
 * state signals. Rather than using hand-fixed rules, the controller combines
 * multiple cheap signals to adjust:
 *
 *   1. pruneThreshold   — minimum confidence required to prune a step result
 *                         (higher = more conservative, keeps more context)
 *   2. escalationRecommended — whether LLM tier is warranted for next call
 *   3. summarizeContext — whether to summarize rather than pass full step results
 *
 * Signals used (all observable at runtime, zero additional LLM calls):
 *   - planLength       — longer plans have more potential for undeclared semantic deps
 *   - stepFailures     — failures suggest the current model tier is insufficient
 *   - repairRate       — fraction of dependency edges repaired by taint tracking;
 *                        high rate means the planner under-declares deps
 *   - tokenFraction    — fraction of token budget consumed; budget pressure
 *                        relaxes the prune threshold (energy savings more urgent)
 *   - complexityEstimate — from the unified planning call
 *
 * The controller does NOT learn across tasks in this implementation;
 * it applies a principled rule set whose weights are configurable.
 * Online learning via a bandit-style controller is left for future work.
 */

export interface ExecutionState {
  /** Number of steps in the current plan */
  planLength: number;
  /** Number of step failures so far in this execution */
  stepFailures: number;
  /** Total tokens consumed so far in this execution */
  tokensConsumed: number;
  /** Token budget ceiling for this task */
  tokenBudget: number;
  /** Complexity estimate from the unified planning call (0.0–1.0) */
  complexityEstimate: number;
  /** Number of dependency edges repaired by taint tracking */
  repairedEdges: number;
  /** Number of edges explicitly declared in planner needs arrays */
  declaredEdges: number;
  /** Index of the current step being executed */
  currentStepIndex: number;
}

export interface AdaptiveDecision {
  /**
   * Minimum confidence score required to prune a step result from the synthesis
   * context. Range 0.0–1.0:
   *   0.0 → prune any step not in the reachability closure (binary, aggressive)
   *   0.5 → prune when moderately confident it is irrelevant
   *   0.9 → prune only when very confident (conservative, keeps more context)
   */
  pruneThreshold: number;
  /**
   * Whether to recommend LLM-tier routing for the next call, based on
   * complexity and failure signals.
   */
  escalationRecommended: boolean;
  /**
   * Whether to summarize completed step results rather than passing full text,
   * triggered when the token budget is tight and the plan is long.
   */
  summarizeContext: boolean;
  /** Human-readable explanation of the decision factors. */
  reason: string;
}

export interface AdaptiveControllerConfig {
  /**
   * Base prune threshold in the absence of pressure signals.
   * Default: 0.75 — prune only when 75%+ confident the step is irrelevant.
   */
  basePruneThreshold?: number;
  /**
   * Token budget fraction at which "budget pressure" is active.
   * Default: 0.80 — budget pressure when 80%+ of tokens are consumed.
   */
  budgetPressureThreshold?: number;
  /**
   * Repair-rate threshold above which dependency uncertainty is flagged.
   * Default: 0.25 — flag when >25% of edges were not declared by the planner.
   */
  highRepairRateThreshold?: number;
}

export class AdaptiveController {
  private readonly basePruneThreshold: number;
  private readonly budgetPressureThreshold: number;
  private readonly highRepairRateThreshold: number;

  constructor(config?: AdaptiveControllerConfig) {
    this.basePruneThreshold = config?.basePruneThreshold ?? 0.75;
    this.budgetPressureThreshold = config?.budgetPressureThreshold ?? 0.80;
    this.highRepairRateThreshold = config?.highRepairRateThreshold ?? 0.25;
  }

  /**
   * Given the current execution state, return the adaptive decision that
   * balances energy savings against output quality risk.
   */
  decide(state: ExecutionState): AdaptiveDecision {
    const reasons: string[] = [];

    // ── Signal: budget pressure ──────────────────────────────────────
    const tokenFraction = state.tokenBudget > 0
      ? state.tokensConsumed / state.tokenBudget
      : 0;
    const budgetPressure = tokenFraction >= this.budgetPressureThreshold;
    if (budgetPressure) {
      reasons.push(`budget=${(tokenFraction * 100).toFixed(0)}%`);
    }

    // ── Signal: dependency uncertainty ───────────────────────────────
    const totalEdges = state.declaredEdges + state.repairedEdges;
    const repairRate = totalEdges > 0 ? state.repairedEdges / totalEdges : 0;
    const highUncertainty = repairRate > this.highRepairRateThreshold;
    if (highUncertainty) {
      reasons.push(`repair_rate=${(repairRate * 100).toFixed(0)}%`);
    }

    // ── Signal: long plan ────────────────────────────────────────────
    const longPlan = state.planLength >= 4;
    if (longPlan) {
      reasons.push(`plan_len=${state.planLength}`);
    }

    // ── Signal: step failures ────────────────────────────────────────
    const hasFailures = state.stepFailures > 0;
    if (hasFailures) {
      reasons.push(`failures=${state.stepFailures}`);
    }

    // ── Compute pruneThreshold ────────────────────────────────────────
    // Start at base and adjust for risk signals (upward) and budget pressure (downward)
    let pruneThreshold = this.basePruneThreshold;

    // Risk signals → raise threshold (be more conservative, prune less)
    if (highUncertainty) pruneThreshold = Math.min(0.95, pruneThreshold + 0.15);
    if (longPlan)        pruneThreshold = Math.min(0.95, pruneThreshold + 0.08);
    if (state.complexityEstimate >= 0.6) {
      pruneThreshold = Math.min(0.95, pruneThreshold + 0.05);
    }

    // Budget pressure → lower threshold (prune more aggressively to save tokens)
    if (budgetPressure) pruneThreshold = Math.max(0.40, pruneThreshold - 0.25);

    // ── Escalation recommendation ─────────────────────────────────────
    // Recommend LLM tier when: complex task AND prior step failed at SLM
    const escalationRecommended =
      state.complexityEstimate >= 0.70 && hasFailures;

    // ── Context summarization ─────────────────────────────────────────
    // Summarize accumulated context when budget is very tight AND plan is long
    const summarizeContext = tokenFraction >= 0.90 && state.planLength >= 5;

    return {
      pruneThreshold,
      escalationRecommended,
      summarizeContext,
      reason: reasons.length > 0 ? reasons.join(', ') : 'baseline',
    };
  }

  /**
   * Convenience: get only the prune threshold for the given state.
   * Equivalent to decide(state).pruneThreshold.
   */
  getPruneThreshold(state: ExecutionState): number {
    return this.decide(state).pruneThreshold;
  }
}
