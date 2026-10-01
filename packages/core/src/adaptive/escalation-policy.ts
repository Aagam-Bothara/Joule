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
  type StepResult,
} from '@joule/shared';
import { consultedAbout, lastFailure, maxRepeatedFailure } from './execution-state.js';

export interface PolicyInput {
  state: ExecutionState;
  confidence: Confidence;
  /** What the agent itself asked for on this turn, if anything */
  agentRequest?: 'consult' | 'give_up' | 'malformed';
  /** Whether a higher rung of the ladder exists and is reachable from the current tier */
  llmAvailable: boolean;
  /** True when the current tier is the top of the ladder (no rung above) */
  atTopRung?: boolean;
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
  ladder: [ModelTier.SLM, ModelTier.MID, ModelTier.LLM],
  failureWindow: 6,
  consultMode: 'patch',
  verification: 'deterministic',
  confidenceSource: 'evidence',
  staticChecks: true,
  observationChars: 1500,
  maxOutputTokens: 4096,
  finalAnswerRequires: 'none',
  breakdownSkipsToTop: false,
  explorationStallSteps: 8,
  rungLocalSteps: false,
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
    // Only the current rung's own failures count: after a handoff the new model
    // starts with a clean slate, otherwise the failures inherited from the rung
    // below would trigger the next handoff on its first turn.
    const since = Math.max(state.handoffAtStep ?? -1, state.step - cfg.failureWindow);
    // ...and only recent ones: "stuck" means failures concentrated in the last
    // few steps, not a count accumulated over a long, otherwise-progressing run.
    const ownFailures = state.failures.filter(f => f.step > since);
    // Failures that moved the verifier forward are progress, and a re-run that
    // reports the same result is not a new failure; neither counts as being stuck.
    // A static-check failure (a file that does not compile) is a cheap slip the
    // agent gets to fix on its own; it only matters when the same one repeats,
    // which the repeat trigger below catches.
    const cheap = ownFailures.filter(f => f.kind === 'static_check_failed').length;
    const failures = Math.max(0, ownFailures.length - cheap - progressVerificationFailures(state, since) - duplicateVerificationFailures(state, since));
    const repeats = maxRepeatedFailure(state, since);
    const last = lastFailure(state);
    /** Occurrences of the latest failure's signature at this rung (Failure.count is global). */
    const lastCount = last ? ownFailures.filter(f => f.signature === last.signature).length : 0;
    /** Did this turn end in a failure? Repeat/consult triggers only fire on a failing turn. */
    const failedNow = last !== undefined && last.step === state.step;

    // ── 1. ABORT ────────────────────────────────────────────────────
    if (!input.canAfford({ tokens: input.minTurnTokens })) {
      return { action: 'abort', reason: 'budget: not enough tokens for another turn' };
    }
    if (last?.kind === 'missing_tool' && last.count >= 2) {
      // Global on purpose: a tool that does not exist does not appear at a higher rung.
      return { action: 'abort', reason: `impossible tool requirement: ${last.toolName} is not available` };
    }
    if (stepsTowardCap(state, cfg.rungLocalSteps) >= cfg.maxSteps) {
      return { action: 'abort', reason: `step limit reached (${cfg.maxSteps}${cfg.rungLocalSteps ? ' per rung' : ''})` };
    }

    // ── 2. HANDOFF hard triggers ────────────────────────────────────
    if (input.agentRequest === 'give_up') {
      return { action: 'handoff', reason: 'agent gave up' };
    }
    if (failures >= cfg.maxFailuresBeforeHandoff) {
      return { action: 'handoff', reason: `${failures} failures (limit ${cfg.maxFailuresBeforeHandoff})` };
    }
    if (last?.kind === 'malformed_action' && lastCount >= 2) {
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
    if (failedNow && last && lastCount >= 2 && !consultedAbout(state, last.signature)) {
      return { action: 'consult', reason: `same failure repeated x${lastCount}: ${last.message}` };
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
    if (this.exploring(state)) {
      return { action: 'consult', reason: `${cfg.explorationStallSteps} steps of reading and searching without a change or a verified result` };
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
    const pinned = state.mode === 'slm-only' || state.mode === 'mid-only' || state.mode === 'llm-only';
    const atLlm = input.atTopRung ?? state.tier === ModelTier.LLM;

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
          return { action: 'abort', reason: `${reason} (already at top tier)` };
        }
      }
      return { action: 'continue', reason: `${reason} (already at top tier)` };
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

  /**
   * Exploration stall: the last N steps all succeeded but none changed a file
   * and none was verified. A model reading a repository for twenty turns never
   * fails, so no other rule sees it. Fires once per stretch: a consult resets
   * the window, and so does any write or verified step.
   */
  private exploring(state: ExecutionState): boolean {
    const n = this.config.explorationStallSteps;
    const since = Math.max(state.handoffAtStep ?? -1, ...state.advice.map(a => a.step));
    const recent = state.completedSteps.filter(s => s.stepIndex > since).slice(-n);
    if (recent.length < n) return false;
    return recent.every(s => s.success && s.verified === undefined && !(typeof s.toolArgs?.content === 'string')
      && (s.output === undefined || typeof s.output !== 'object' || (s.output as { written?: unknown }).written !== true));
  }

  private stalled(state: ExecutionState): boolean {
    const n = this.config.stallSteps;
    // Rung-local: steps before the last handoff belong to the previous model.
    const since = state.handoffAtStep ?? -1;
    const recent = state.completedSteps.filter(s => s.stepIndex > since).slice(-n);
    if (recent.length < n) return false;
    // A verification that failed but passed more checks than the previous one is progress.
    return recent.every((s, i) => {
      if (s.success && s.verified !== false) return false;
      const prev = recent[i - 1] ?? state.completedSteps[state.completedSteps.length - n - 1];
      return !(s.verified === false && s.verifyScore !== undefined && prev?.verifyScore !== undefined && s.verifyScore > prev.verifyScore);
    });
  }
}

/**
 * Steps a verifier actually ran on, with re-observations collapsed: a failed
 * verification that immediately follows another failed verification with the
 * same pass fraction (a test run right after a verified write) is the same
 * result seen twice, not a new attempt. Unverified steps such as plain file
 * writes are skipped.
 */
function verifiedSteps(state: ExecutionState): StepResult[] {
  const out: StepResult[] = [];
  const all = state.completedSteps;
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    if (s.verified === undefined) continue;
    // Static checks are not attempts at the task's own verifier.
    if (s.verifierKind === 'static_check') continue;
    const prev = all[i - 1];
    const duplicate = s.verified === false && prev?.verified === false
      && s.verifyScore !== undefined && prev.verifyScore !== undefined && s.verifyScore === prev.verifyScore;
    if (!duplicate) out.push(s);
  }
  return out;
}

/** Consecutive most-recent verified steps whose verification failed. */
export function verifyFailStreak(state: ExecutionState): number {
  const vs = verifiedSteps(state);
  let n = 0;
  for (let i = vs.length - 1; i >= 0; i--) {
    if (vs[i].verified === false) n++;
    else break;
  }
  return n;
}

/**
 * Did the most recent failed verification pass more checks than the verified
 * attempt before it? Compares verified attempts, so a file write between two
 * test runs does not hide the progress.
 */
export function improvedOnLastRetry(state: ExecutionState): boolean {
  const vs = verifiedSteps(state);
  const last = vs[vs.length - 1];
  const prev = vs[vs.length - 2];
  if (!last || !prev || last.verified !== false || prev.verified !== false) return false;
  if (last.verifyScore === undefined || prev.verifyScore === undefined) return false;
  return last.verifyScore > prev.verifyScore;
}

/**
 * Verification failures that were progress: they passed more checks than the
 * verified attempt before them. Building a module incrementally produces a run
 * of these ("3/12", "6/12", "9/12"); they must not count toward the failure
 * limit that forces a handoff.
 */
export function progressVerificationFailures(state: ExecutionState, sinceStep = -1): number {
  const vs = verifiedSteps(state);
  let n = 0;
  for (let i = 1; i < vs.length; i++) {
    const s = vs[i];
    const prev = vs[i - 1];
    if (s.stepIndex <= sinceStep) continue;
    if (s.verified === false && s.verifyScore !== undefined && prev.verifyScore !== undefined && s.verifyScore > prev.verifyScore) n++;
  }
  return n;
}

/**
 * Verification failures that merely re-observed the previous result: a test
 * run right after a verified write, reporting the same pass fraction, is the
 * same failure seen twice. It must not count as a second failure.
 */
export function duplicateVerificationFailures(state: ExecutionState, sinceStep = -1): number {
  const steps = state.completedSteps;
  let n = 0;
  for (let i = 1; i < steps.length; i++) {
    const s = steps[i];
    const prev = steps[i - 1];
    if (s.stepIndex <= sinceStep) continue;
    if (s.verified !== false || prev.verified !== false) continue;
    if (s.verifyScore !== undefined && prev.verifyScore !== undefined && s.verifyScore === prev.verifyScore) n++;
  }
  return n;
}

/** Steps counted against `maxSteps`: all of them, or only the current rung's when the cap is rung-local. */
export function stepsTowardCap(state: ExecutionState, rungLocal: boolean): number {
  if (!rungLocal || state.handoffAtStep === undefined) return state.step;
  return state.step - state.handoffAtStep - 1;
}

function stripUndefined<T extends object>(obj?: T): Partial<T> {
  if (!obj) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
