/**
 * EscalationPolicy V1 — rule-based.
 *
 * Evaluated after every agent turn. Produces one of:
 *   continue → the current tier keeps working
 *   consult  → ask the LLM one focused question, then return to the SLM
 *   handoff  → the LLM takes over from the current state
 *   abort    → budget / safety / impossible task
 *
 * Order of evaluation:
 *   1. ABORT   hard stops (budget, impossible tool, give-up with nowhere to go)
 *   2. HANDOFF hard triggers (failure count, consults exhausted, agent gave up, malformed output)
 *   3. CONSULT deterministic triggers (repeat failure, verification failure, stall, agent asked)
 *   4. soft thresholds on the composite confidence
 *
 * Every escalation is gated by affordability: a consult must fit in the
 * remaining cost/tokens; a handoff also needs an escalation unit.
 *
 * Modes restrict the action space:
 *   slm-only / llm-only  never consult or hand off; hard failure → abort
 *   adaptive at LLM tier  (after a handoff) consult is meaningless → continue; second failure wave → abort
 */

import {
  ModelTier,
  isoNow,
  type Confidence,
  type EscalationAction,
  type EscalationDecision,
  type EscalationPolicyConfig,
  type ExecutionState,
} from '@joule/shared';
import { consultedAbout, lastFailure, maxRepeatedFailure } from './execution-state.js';

export interface PolicyInput {
  state: ExecutionState;
  confidence: Confidence;
  /** What the agent itself asked for on this turn, if anything */
  agentRequest?: 'consult' | 'give_up' | 'malformed';
  /** Whether an LLM tier provider is reachable at all */
  llmAvailable: boolean;
  /** Escalation units left in the envelope (handoff needs one) */
  canEscalate: boolean;
  /** Continuous affordability check from BudgetManager */
  canAfford: (need: { costUsd?: number; tokens?: number }) => boolean;
  estimatedConsultCostUsd: number;
  estimatedHandoffCostUsd: number;
  /** Minimum tokens a further agent turn needs */
  minTurnTokens: number;
}

export const DEFAULT_POLICY_CONFIG: Required<EscalationPolicyConfig> = {
  maxSteps: 25,
  consultThreshold: 0.55,
  handoffThreshold: 0.35,
  maxFailuresBeforeHandoff: 3,
  maxConsultations: 3,
  consultMaxTokens: 800,
  llmJudge: false,
  stallSteps: 3,
  verifyRetries: 1,
};

export class RuleBasedEscalationPolicy {
  readonly config: Required<EscalationPolicyConfig>;

  constructor(config?: EscalationPolicyConfig) {
    this.config = { ...DEFAULT_POLICY_CONFIG, ...stripUndefined(config) };
  }

  evaluate(input: PolicyInput): EscalationDecision {
    const { state, confidence } = input;
    const proposal = this.propose(input);
    const { action, reason } = this.applyMode(proposal.action, proposal.reason, input);

    return {
      step: state.step,
      action,
      score: confidence.composite,
      reason,
      confidence,
      tier: state.tier,
      estimatedCostUsd: action === 'consult'
        ? input.estimatedConsultCostUsd
        : action === 'handoff' ? input.estimatedHandoffCostUsd : undefined,
      timestamp: isoNow(),
    };
  }

  /** The mode-agnostic rule ladder. */
  private propose(input: PolicyInput): { action: EscalationAction; reason: string } {
    const { state, confidence } = input;
    const cfg = this.config;
    const failures = state.failures.length;
    const repeats = maxRepeatedFailure(state);
    const last = lastFailure(state);
    /** Did this turn end in a failure? Repeat/consult triggers only fire on a failing turn. */
    const failedNow = last !== undefined && last.step === state.step;

    // ── 1. ABORT ────────────────────────────────────────────────────
    if (!input.canAfford({ tokens: input.minTurnTokens })) {
      return { action: 'abort', reason: 'budget: not enough tokens for another turn' };
    }
    if (last?.kind === 'missing_tool' && last.count >= 2) {
      return { action: 'abort', reason: `impossible tool requirement: ${last.toolName} is not available` };
    }
    if (state.step >= cfg.maxSteps) {
      return { action: 'abort', reason: `step limit reached (${cfg.maxSteps})` };
    }

    // ── 2. HANDOFF hard triggers ────────────────────────────────────
    if (input.agentRequest === 'give_up') {
      return { action: 'handoff', reason: 'agent gave up' };
    }
    if (failures >= cfg.maxFailuresBeforeHandoff) {
      return { action: 'handoff', reason: `${failures} failures (limit ${cfg.maxFailuresBeforeHandoff})` };
    }
    if (last?.kind === 'malformed_action' && last.count >= 2) {
      return { action: 'handoff', reason: 'agent cannot produce a valid action' };
    }
    if (state.consultations >= cfg.maxConsultations && confidence.composite < cfg.consultThreshold) {
      return { action: 'handoff', reason: `consultations exhausted (${state.consultations}) and confidence ${confidence.composite} still low` };
    }

    // ── 3. CONSULT deterministic triggers ───────────────────────────
    if (input.agentRequest === 'consult') {
      // A question with no evidence behind it is a guess, not a localized problem.
      const hasEvidence = state.completedSteps.length > 0 || failures > 0;
      return hasEvidence
        ? { action: 'consult', reason: 'agent asked a focused question' }
        : { action: 'continue', reason: 'agent asked for help before gathering any evidence' };
    }
    if (failedNow && last && last.count >= 2 && !consultedAbout(state, last.signature)) {
      return { action: 'consult', reason: `same failure repeated x${last.count}: ${last.message}` };
    }
    // Verification failures: the agent gets `verifyRetries` attempts of its own
    // first (a developer reruns tests after a fix). Consult only when the failures
    // keep coming AND the last attempt did not improve on the one before it.
    if (confidence.contradiction > 0) {
      const streak = verifyFailStreak(state);
      if (streak > cfg.verifyRetries && !improvedOnLastRetry(state)) {
        return { action: 'consult', reason: `verification failed ${streak}x with no improvement` };
      }
    }
    if (this.stalled(state)) {
      return { action: 'consult', reason: `no verified progress in the last ${cfg.stallSteps} steps` };
    }

    // ── 4. Soft thresholds ──────────────────────────────────────────
    // A single failure is the SLM's to retry; thresholds only bite once
    // there is a pattern (two or more failures of any kind) and the last
    // retry did not move the verifier forward.
    const improving = improvedOnLastRetry(state);
    if (failures >= 2 && !improving && confidence.composite < cfg.handoffThreshold) {
      return { action: 'handoff', reason: `confidence ${confidence.composite} below handoff threshold ${cfg.handoffThreshold}` };
    }
    if (failures >= 2 && !improving && confidence.composite < cfg.consultThreshold) {
      return { action: 'consult', reason: `confidence ${confidence.composite} below consult threshold ${cfg.consultThreshold}` };
    }
    if (improving) {
      return { action: 'continue', reason: `verification improving (${confidence.composite})` };
    }

    return { action: 'continue', reason: `confidence ${confidence.composite}` };
  }

  /** Restrict the proposal to what the mode, tier and budget allow. */
  private applyMode(
    action: EscalationAction,
    reason: string,
    input: PolicyInput,
  ): { action: EscalationAction; reason: string } {
    const { state } = input;
    const cfg = this.config;
    const pinned = state.mode === 'slm-only' || state.mode === 'llm-only';
    const atLlm = state.tier === ModelTier.LLM;

    if (action === 'continue' || action === 'abort') return { action, reason };

    // Pinned modes never escalate. A hard handoff trigger becomes an abort;
    // a consult trigger becomes continue (the model keeps trying within limits).
    if (pinned) {
      if (action === 'handoff') {
        return { action: 'abort', reason: `${reason} (mode ${state.mode}: escalation disabled)` };
      }
      return { action: 'continue', reason: `${reason} (mode ${state.mode}: consult disabled)` };
    }

    // Already at the LLM tier: consulting the LLM is pointless; a second
    // failure wave after the handoff is a genuine failure.
    if (atLlm) {
      if (action === 'handoff') {
        // Failures at the handoff step itself belong to the SLM; count only the LLM's own.
        const sinceHandoff = state.failures.filter(f => f.step > (state.handoffAtStep ?? -1)).length;
        if (input.agentRequest === 'give_up' || sinceHandoff >= cfg.maxFailuresBeforeHandoff) {
          return { action: 'abort', reason: `${reason} (already at LLM tier)` };
        }
      }
      return { action: 'continue', reason: `${reason} (already at LLM tier)` };
    }

    // Budget-aware gating for adaptive mode at the SLM tier.
    if (action === 'consult') {
      if (!input.llmAvailable) return { action: 'continue', reason: `${reason} (no LLM provider available)` };
      if (state.consultations >= cfg.maxConsultations) {
        return this.applyMode('handoff', `${reason}; consultations exhausted`, input);
      }
      if (!input.canAfford({ costUsd: input.estimatedConsultCostUsd })) {
        return { action: 'continue', reason: `${reason} (consult not affordable: $${input.estimatedConsultCostUsd.toFixed(4)})` };
      }
      return { action, reason };
    }

    // handoff
    if (!input.llmAvailable) {
      return input.agentRequest === 'give_up'
        ? { action: 'abort', reason: `${reason} (no LLM provider available)` }
        : { action: 'continue', reason: `${reason} (no LLM provider available)` };
    }
    if (!input.canEscalate) {
      return { action: 'abort', reason: `${reason} (no escalation budget left)` };
    }
    if (!input.canAfford({ costUsd: input.estimatedHandoffCostUsd })) {
      return { action: 'abort', reason: `${reason} (handoff not affordable: $${input.estimatedHandoffCostUsd.toFixed(4)})` };
    }
    return { action, reason };
  }

  private stalled(state: ExecutionState): boolean {
    const n = this.config.stallSteps;
    const recent = state.completedSteps.slice(-n);
    if (recent.length < n) return false;
    // A verification that failed but passed more checks than the previous one is progress.
    return recent.every((s, i) => {
      if (s.success && s.verified !== false) return false;
      const prev = recent[i - 1] ?? state.completedSteps[state.completedSteps.length - n - 1];
      return !(s.verified === false && s.verifyScore !== undefined && prev?.verifyScore !== undefined && s.verifyScore > prev.verifyScore);
    });
  }
}

/** Consecutive most-recent steps whose verification failed. */
export function verifyFailStreak(state: ExecutionState): number {
  let n = 0;
  for (let i = state.completedSteps.length - 1; i >= 0; i--) {
    if (state.completedSteps[i].verified === false) n++;
    else break;
  }
  return n;
}

/** Did the last failed verification pass more checks than the one before it? */
export function improvedOnLastRetry(state: ExecutionState): boolean {
  const steps = state.completedSteps;
  const last = steps[steps.length - 1];
  const prev = steps[steps.length - 2];
  if (!last || !prev || last.verified !== false || prev.verified !== false) return false;
  if (last.verifyScore === undefined || prev.verifyScore === undefined) return false;
  return last.verifyScore > prev.verifyScore;
}

function stripUndefined<T extends object>(obj?: T): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
