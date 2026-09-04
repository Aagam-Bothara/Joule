/**
 * ExecutionState helpers.
 *
 * The state is the single source of truth for a run. Everything the SLM has
 * learned lives here, so a consultation or a handoff is derived from it
 * instead of re-reading the original prompt.
 */

import {
  isoNow,
  type Advice,
  type BudgetUsage,
  type ConsultationRequest,
  type EscalationDecision,
  type ExecutionMode,
  type ExecutionState,
  type Failure,
  type FailureKind,
  type HandoffContext,
  type Hypothesis,
  type ModelTier,
  type Observation,
  type PlanVersion,
  type StepResult,
} from '@joule/shared';

/** Tool outputs are truncated to this many characters before entering state. */
export const MAX_OBSERVATION_CHARS = 600;

export function createExecutionState(args: {
  taskId: string;
  goal: string;
  constraints?: string[];
  mode: ExecutionMode;
  tier: ModelTier;
  budget: BudgetUsage;
}): ExecutionState {
  return {
    taskId: args.taskId,
    goal: args.goal,
    constraints: args.constraints ?? [],
    mode: args.mode,
    tier: args.tier,
    planVersions: [],
    step: 0,
    completedSteps: [],
    observations: [],
    failures: [],
    hypotheses: [],
    advice: [],
    decisions: [],
    consultations: 0,
    handoffs: 0,
    budget: args.budget,
    status: 'running',
    startedAt: isoNow(),
  };
}

export function truncate(text: string, max = MAX_OBSERVATION_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

export function stringifyOutput(output: unknown): string {
  if (output === undefined || output === null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Strip paths, ids, timestamps and large numbers so repeats of the same error match. */
export function normalizeErrorSignature(error: string): string {
  return error
    .replace(/[A-Z]:\\[\w\\.-]+/gi, '<path>')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/\/[\w/.-]+/g, '<path>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<timestamp>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d{2,}/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

// ── Plan versions ────────────────────────────────────────────────────

export function currentPlan(state: ExecutionState): string[] {
  const latest = state.planVersions[state.planVersions.length - 1];
  return latest ? latest.steps : [];
}

/** Append a new plan version when the plan actually changed. Never splices. */
export function pushPlan(state: ExecutionState, steps: string[], source: PlanVersion['source']): boolean {
  const cleaned = steps.map(s => String(s).trim()).filter(Boolean);
  if (cleaned.length === 0) return false;
  const existing = currentPlan(state);
  if (existing.length === cleaned.length && existing.every((s, i) => s === cleaned[i])) return false;
  state.planVersions.push({
    version: state.planVersions.length + 1,
    step: state.step,
    steps: cleaned,
    source,
  });
  return true;
}

// ── Recording ────────────────────────────────────────────────────────

export function recordStep(state: ExecutionState, result: StepResult): void {
  state.completedSteps.push(result);
}

export function recordObservation(
  state: ExecutionState,
  obs: Omit<Observation, 'step' | 'content'> & { step?: number; content: string },
): Observation {
  const observation: Observation = {
    ...obs,
    step: obs.step ?? state.step,
    content: truncate(obs.content),
  };
  state.observations.push(observation);
  return observation;
}

export function recordFailure(
  state: ExecutionState,
  args: { toolName: string; message: string; kind: FailureKind; step?: number },
): Failure {
  const signature = `${args.kind}:${args.toolName}:${normalizeErrorSignature(args.message)}`;
  const previous = state.failures.filter(f => f.signature === signature).length;
  const failure: Failure = {
    step: args.step ?? state.step,
    toolName: args.toolName,
    signature,
    message: truncate(args.message, 300),
    count: previous + 1,
    kind: args.kind,
  };
  state.failures.push(failure);
  return failure;
}

export function recordHypothesis(state: ExecutionState, text: string, source: Hypothesis['source']): void {
  const cleaned = text.trim();
  if (!cleaned) return;
  if (state.hypotheses.some(h => h.text === cleaned)) return;
  state.hypotheses.push({ step: state.step, text: truncate(cleaned, 300), source });
}

export function recordDecision(state: ExecutionState, decision: EscalationDecision): void {
  state.decisions.push(decision);
}

// ── Queries ──────────────────────────────────────────────────────────

/** Highest repeat count of any single failure signature. */
export function maxRepeatedFailure(state: ExecutionState): number {
  return state.failures.reduce((m, f) => Math.max(m, f.count), 0);
}

export function lastFailure(state: ExecutionState): Failure | undefined {
  return state.failures[state.failures.length - 1];
}

/** Has a consultation already happened since this failure signature first appeared? */
export function consultedAbout(state: ExecutionState, signature: string): boolean {
  const first = state.failures.find(f => f.signature === signature);
  if (!first) return false;
  return state.advice.some(a => a.step >= first.step);
}

/** Most recent observations, failures and verifier results first. */
export function relevantObservations(state: ExecutionState, limit = 8): Observation[] {
  const recent = state.observations.slice(-limit * 2);
  const failures = recent.filter(o => o.success === false || o.source === 'verifier');
  const others = recent.filter(o => !failures.includes(o));
  return [...failures, ...others].slice(-limit);
}

// ── Consult / Handoff payloads ───────────────────────────────────────

export function toConsultationRequest(
  state: ExecutionState,
  question: string,
  consultId: string,
  maxTokens: number,
): ConsultationRequest {
  return {
    consultId,
    goal: state.goal,
    question,
    relevantEvidence: relevantObservations(state),
    hypotheses: state.hypotheses.slice(-5),
    attemptedSolutions: state.completedSteps.filter(s => !s.success || s.verified === false).slice(-5),
    constraints: state.constraints,
    maxTokens,
  };
}

export function toHandoffContext(state: ExecutionState, unresolvedQuestions: string[] = []): HandoffContext {
  const plan = currentPlan(state);
  const done = state.completedSteps.filter(s => s.success && s.verified !== false).length;
  return {
    originalGoal: state.goal,
    currentPlan: plan,
    completedWork: state.completedSteps.slice(-10),
    relevantObservations: relevantObservations(state, 10),
    hypotheses: state.hypotheses.slice(-5),
    failures: state.failures.slice(-6),
    advice: state.advice.slice(-3),
    unresolvedQuestions,
    recommendedNextSteps: plan.slice(Math.min(done, Math.max(0, plan.length - 1))),
    remainingBudget: state.budget,
  };
}

// ── Rendering for prompts ────────────────────────────────────────────

function renderStep(s: StepResult): string {
  const status = s.success ? (s.verified === false ? 'OK but verification FAILED' : 'OK') : 'FAILED';
  const body = s.success ? truncate(stringifyOutput(s.output), 240) : truncate(s.error ?? 'unknown error', 240);
  const desc = s.description ? ` — ${s.description}` : '';
  return `- step ${s.stepIndex + 1} [${s.toolName}]${desc}: ${status}. ${body}`;
}

export function renderConsultation(req: ConsultationRequest): string {
  const lines: string[] = [];
  lines.push('GOAL', req.goal, '');
  lines.push('QUESTION', req.question, '');
  if (req.relevantEvidence.length > 0) {
    lines.push('EVIDENCE');
    for (const o of req.relevantEvidence) {
      lines.push(`- [${o.source}${o.toolName ? `:${o.toolName}` : ''}${o.success === false ? ' FAILED' : ''}] ${o.content}`);
    }
    lines.push('');
  }
  if (req.hypotheses.length > 0) {
    lines.push('HYPOTHESES');
    for (const h of req.hypotheses) lines.push(`- ${h.text}`);
    lines.push('');
  }
  if (req.attemptedSolutions.length > 0) {
    lines.push('ATTEMPTS THAT DID NOT WORK');
    for (const s of req.attemptedSolutions) lines.push(renderStep(s));
    lines.push('');
  }
  if (req.constraints.length > 0) {
    lines.push('CONSTRAINTS');
    for (const c of req.constraints) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push(`Answer the question directly and concretely in at most ${req.maxTokens} tokens. Do not solve the whole task; the smaller model will continue.`);
  return lines.join('\n');
}

export function renderHandoff(ctx: HandoffContext): string {
  const lines: string[] = [];
  lines.push('You are taking over an in-progress task from a smaller model. Do NOT restart from scratch — continue from the current state below.');
  lines.push('First reassess the approach: if the failures show the previous strategy was wrong (for example, using tools on files or services that do not exist), change strategy instead of retrying it. If the task can be completed from reasoning alone, answer directly with final_answer.', '');
  lines.push('GOAL', ctx.originalGoal, '');
  if (ctx.currentPlan.length > 0) {
    lines.push('CURRENT PLAN');
    ctx.currentPlan.forEach((p, i) => lines.push(`${i + 1}. ${p}`));
    lines.push('');
  }
  if (ctx.completedWork.length > 0) {
    lines.push('COMPLETED WORK');
    for (const s of ctx.completedWork) lines.push(renderStep(s));
    lines.push('');
  }
  if (ctx.relevantObservations.length > 0) {
    lines.push('KEY OBSERVATIONS');
    for (const o of ctx.relevantObservations) {
      lines.push(`- [${o.source}${o.toolName ? `:${o.toolName}` : ''}] ${o.content}`);
    }
    lines.push('');
  }
  if (ctx.hypotheses.length > 0) {
    lines.push('HYPOTHESES');
    for (const h of ctx.hypotheses) lines.push(`- (${h.source}) ${h.text}`);
    lines.push('');
  }
  if (ctx.failures.length > 0) {
    lines.push('FAILURES');
    for (const f of ctx.failures) lines.push(`- step ${f.step + 1} [${f.toolName}] ${f.kind}${f.count > 1 ? ` (x${f.count})` : ''}: ${f.message}`);
    lines.push('');
  }
  if (ctx.advice.length > 0) {
    lines.push('ADVICE ALREADY RECEIVED');
    for (const a of ctx.advice) lines.push(`- Q: ${truncate(a.question, 200)}\n  A: ${truncate(a.answer, 400)}`);
    lines.push('');
  }
  if (ctx.unresolvedQuestions.length > 0) {
    lines.push('UNRESOLVED');
    for (const q of ctx.unresolvedQuestions) lines.push(`- ${q}`);
    lines.push('');
  }
  if (ctx.recommendedNextSteps.length > 0) {
    lines.push('SUGGESTED NEXT STEPS');
    for (const s of ctx.recommendedNextSteps) lines.push(`- ${s}`);
    lines.push('');
  }
  const b = ctx.remainingBudget;
  lines.push(`REMAINING BUDGET: ${Math.max(0, b.toolCallsRemaining)} tool calls, $${Math.max(0, b.costRemaining).toFixed(4)}, ${Number.isFinite(b.tokensRemaining) ? Math.max(0, b.tokensRemaining) : '∞'} tokens`);
  return lines.join('\n');
}

/** Compact one-screen summary of the state, used in prompts and logs. */
export function summarizeState(state: ExecutionState): string {
  const plan = currentPlan(state);
  const ok = state.completedSteps.filter(s => s.success).length;
  const lines = [
    `goal: ${state.goal}`,
    `tier: ${state.tier}  step: ${state.step}  steps ok/total: ${ok}/${state.completedSteps.length}  failures: ${state.failures.length}  consults: ${state.consultations}  handoffs: ${state.handoffs}`,
  ];
  if (plan.length > 0) lines.push(`plan: ${plan.map((p, i) => `${i + 1}) ${p}`).join(' ')}`);
  const lf = lastFailure(state);
  if (lf) lines.push(`last failure: [${lf.toolName}] ${lf.message}`);
  return lines.join('\n');
}

export function adviceBlock(advice: Advice): string {
  return `<advice consult="${advice.consultId}">\nQ: ${advice.question}\nA: ${advice.answer}\n</advice>`;
}
