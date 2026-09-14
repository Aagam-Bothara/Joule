/**
 * AdaptiveExecutor — Joule's core execution loop.
 *
 *   Task
 *    ↓
 *   StepAgent at the current tier (SLM by default)
 *    ↓
 *   Execute tool / Observe / Verify → update ExecutionState
 *    ↓
 *   ConfidenceEngine → EscalationPolicy
 *    ├── continue → same tier keeps working
 *    ├── consult  → Consultant asks the LLM one question; advice returns to the SLM
 *    ├── handoff  → tier := LLM, conversation rebuilt from HandoffContext (no restart)
 *    └── abort    → budget / safety / impossible
 *
 * The same loop serves every mode; only the policy's action space differs.
 */

import {
  ModelTier,
  TIER_ORDER,
  ConstitutionViolationError,
  BudgetExhaustedError,
  MODEL_PRICING,
  generateId,
  type Advice,
  type BudgetUsage,
  type ChatMessage,
  type ConsultEdit,
  type EnergyConfig,
  type EscalationDecision,
  type EscalationPolicyConfig,
  type ExecutionMode,
  type ExecutionState,
  type StepResult,
  type Task,
  type TaskStatus,
} from '@joule/shared';
import type { ModelProviderRegistry } from '@joule/models';
import type { BudgetManager, BudgetEnvelopeInstance } from '../budget-manager.js';
import type { ModelRouter } from '../model-router.js';
import type { TraceLogger } from '../trace-logger.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ConstitutionEnforcer } from '../constitution.js';
import type { ProgressCallback } from '../task-executor.js';
import {
  adviceBlock,
  createExecutionState,
  currentFiles,
  currentPlan,
  lastFailure,
  pushPlan,
  recordDecision,
  recordFailure,
  recordHypothesis,
  recordObservation,
  recordStep,
  renderHandoff,
  stringifyOutput,
  toConsultationRequest,
  toHandoffContext,
  truncate,
  writeToolName,
} from './execution-state.js';
import { ConfidenceEngine } from './confidence-engine.js';
import { RuleBasedEscalationPolicy, stepsTowardCap } from './escalation-policy.js';
import { StepAgent, type AgentAction, type StepAgentTurn } from './step-agent.js';
import { StepVerifier, staticCheck } from './verifier.js';
import { Consultant } from './consultant.js';

export interface AdaptiveExecutorDeps {
  budget: BudgetManager;
  router: ModelRouter;
  tracer: TraceLogger;
  tools: ToolRegistry;
  providers: ModelProviderRegistry;
  energyConfig?: EnergyConfig;
  constitution?: ConstitutionEnforcer;
  policy?: EscalationPolicyConfig;
}

/** Live references the caller can read even if the run throws mid-way. */
export interface AdaptiveAttach {
  stepResults: StepResult[];
  state?: ExecutionState;
  /** Human descriptions per agent turn, for the trajectory tree */
  turnDescriptions: Record<number, string>;
  llmPricePerToken?: number;
}

export interface AdaptiveRunResult {
  status: TaskStatus;
  result?: string;
  error?: string;
  state: ExecutionState;
  llmPricePerToken?: number;
}

const MIN_TURN_TOKENS = 400;

interface TierProbe {
  available: boolean;
  pricePerToken?: number;
}

export class AdaptiveExecutor {
  private readonly engine = new ConfidenceEngine();
  private readonly policy: RuleBasedEscalationPolicy;
  private readonly agent: StepAgent;
  private readonly verifier: StepVerifier;
  private readonly consultant: Consultant;

  constructor(private deps: AdaptiveExecutorDeps) {
    this.policy = new RuleBasedEscalationPolicy(deps.policy);
    const cfg = this.policy.config;
    this.agent = new StepAgent(deps.router, deps.providers, deps.tools, {
      constitution: deps.constitution,
      askConfidence: cfg.confidenceSource === 'self-report',
      maxTokens: cfg.maxOutputTokens,
    });
    this.verifier = new StepVerifier(deps.tools, { allowLlmJudge: cfg.llmJudge });
    this.consultant = new Consultant(deps.router, deps.providers, deps.budget, deps.tracer, deps.energyConfig, cfg.consultMode);
  }

  async run(
    task: Task,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    mode: ExecutionMode,
    attach: AdaptiveAttach,
    onProgress?: ProgressCallback,
  ): Promise<AdaptiveRunResult> {
    const { budget, tracer, constitution } = this.deps;
    const cfg = this.policy.config;

    if (constitution) {
      const violation = constitution.validateTask(task.description);
      if (violation) {
        tracer.logEvent(traceId, 'constitution_violation', violation as unknown as Record<string, unknown>);
        throw new ConstitutionViolationError(violation.ruleId, violation.ruleName, violation.description);
      }
    }

    // ── Ladder ──────────────────────────────────────────────────────
    // Rungs no provider serves are dropped, so a two-model setup is [slm, llm].
    const probes = new Map<ModelTier, TierProbe>();
    for (const t of TIER_ORDER) probes.set(t, await this.probe(t, envelope));
    const ladder = this.resolveLadder(mode, probes);
    let rung = 0;
    const startTier = ladder[0];
    const topTier = ladder[ladder.length - 1];
    const nextTier = (): ModelTier | undefined => ladder[rung + 1];
    const priceOf = (t: ModelTier | undefined): number => (t ? probes.get(t)?.pricePerToken ?? 0 : 0);
    attach.llmPricePerToken = probes.get(topTier)?.pricePerToken;

    const state = createExecutionState({
      taskId: task.id,
      goal: cleanDescription(task.description),
      mode,
      tier: startTier,
      budget: budget.getUsage(envelope),
    });
    attach.state = state;

    tracer.logEvent(traceId, 'info', {
      type: 'adaptive_start',
      mode,
      tier: startTier,
      ladder,
      llmAvailable: ladder.length > 1,
      llmPricePerToken: attach.llmPricePerToken,
    });

    let messages: ChatMessage[] = [{ role: 'user', content: this.initialMessage(task, envelope) }];
    let pendingUser: string[] = [];
    let activeConsultId: string | undefined;
    let pendingQuestion: string | undefined;
    let consecutiveModelErrors = 0;
    /** Latest self-reported confidence (self-report ablation only) */
    let selfReported: number | undefined;

    const usage = (): BudgetUsage => budget.getUsage(envelope);
    // Escalation cost estimates are priced at the next rung, not the top.
    const consultCost = (): number => priceOf(nextTier()) * (cfg.consultMaxTokens + 1500);
    const handoffCost = (): number => priceOf(nextTier()) * 3 * 2500;

    // ── Main loop ───────────────────────────────────────────────────
    while (state.status === 'running') {
      state.budget = usage();
      budget.checkBudget(envelope);
      if (stepsTowardCap(state, cfg.rungLocalSteps) >= cfg.maxSteps) {
        const decision = this.policy.evaluate({
          state, confidence: this.engine.compute(state, state.budget), llmAvailable: nextTier() !== undefined, atTopRung: nextTier() === undefined,
          canEscalate: false, canAfford: () => true, estimatedConsultCostUsd: 0, estimatedHandoffCostUsd: 0, minTurnTokens: 0,
        });
        decision.action = 'abort';
        decision.reason = `step limit reached (${cfg.maxSteps})`;
        recordDecision(state, decision);
        this.logDecision(traceId, decision, undefined, 'step limit');
        state.status = 'aborted';
        state.error = decision.reason;
        break;
      }
      onProgress?.({ phase: 'executing', stepIndex: state.step, totalSteps: cfg.maxSteps, usage: state.budget, state: 'act' });

      if (pendingUser.length > 0) {
        messages.push({ role: 'user', content: pendingUser.join('\n\n') });
        pendingUser = [];
      }

      // AGENT TURN
      let agentRequest: 'consult' | 'give_up' | 'malformed' | undefined;
      let turn: StepAgentTurn | undefined;
      try {
        turn = await this.agent.next(task, state, envelope, state.tier, messages);
        consecutiveModelErrors = 0;
      } catch (err) {
        if (err instanceof BudgetExhaustedError) throw err;
        consecutiveModelErrors++;
        const message = err instanceof Error ? err.message : String(err);
        recordFailure(state, { toolName: 'model', message, kind: 'model_error' });
        tracer.logEvent(traceId, 'error', { type: 'agent_model_error', step: state.step, message });
        attach.turnDescriptions[state.step] = 'model call failed';
        if (consecutiveModelErrors >= 2) agentRequest = 'give_up';
      }

      let stepResult: StepResult | undefined;
      if (turn) {
        const charged = budget.recordModelResponse(envelope, turn.response, this.deps.energyConfig);
        tracer.logModelCall(traceId, turn.request, { ...turn.response, costUsd: charged.costUsd });
        messages.push({ role: 'assistant', content: turn.response.content });
        tracer.logEvent(traceId, 'agent_action', {
          step: state.step,
          type: turn.action.type,
          tier: state.tier,
          model: turn.response.model,
          toolName: turn.action.type === 'tool_call' ? turn.action.toolName : undefined,
        });

        const action = turn.action;
        if (action.type === 'tool_call' || action.type === 'final_answer') {
          if (action.confidence !== undefined) selfReported = action.confidence;
        }
        switch (action.type) {
          case 'tool_call': {
            if (action.plan) pushPlan(state, action.plan, 'agent');
            if (action.hypothesis) recordHypothesis(state, action.hypothesis, 'agent');
            attach.turnDescriptions[state.step] = action.description;
            stepResult = await this.executeTool(action, state, envelope, traceId, turn, activeConsultId);
            if (action.confidence !== undefined) stepResult.selfConfidence = action.confidence;
            if (turn.response.meanLogprob !== undefined) stepResult.meanLogprob = turn.response.meanLogprob;
            attach.stepResults.push(stepResult);
            pendingUser.push(this.observationMessage(stepResult));
            break;
          }
          case 'final_answer': {
            if (action.plan) pushPlan(state, action.plan, 'agent');
            if (cfg.finalAnswerRequires !== 'none') {
              // Finishing without doing (or checking) the work is a failure signal like
              // any other: it is counted, the agent is sent back, and repeats escalate.
              const lastWrite = state.completedSteps.filter(s => s.success && isWriteStep(s)).at(-1);
              const verifiedSince = lastWrite !== undefined && state.completedSteps.some(s => s.stepIndex > lastWrite.stepIndex && s.success && s.verified === true);
              const refusal = !lastWrite
                ? 'no file has been changed yet. Make the change, verify it, then finish.'
                : cfg.finalAnswerRequires === 'verified' && !verifiedSince
                  ? 'nothing has been verified since your last change. Run the relevant tests or a check that exits 0, then finish.'
                  : undefined;
              if (refusal) {
                attach.turnDescriptions[state.step] = `final answer refused (${lastWrite ? 'unverified change' : 'no change'})`;
                recordFailure(state, { toolName: 'agent', message: lastWrite ? 'finished without verifying the change' : 'finished without changing any file', kind: 'verification_failed' });
                recordObservation(state, { source: 'agent', content: `final answer refused: ${refusal} ${truncate(action.answer, 200)}`, success: false });
                pendingUser.push(`Your final answer was not accepted: ${refusal} Respond with the next action as JSON.`);
                break;
              }
            }
            attach.turnDescriptions[state.step] = 'final answer';
            state.result = action.answer;
            state.status = 'completed';
            break;
          }
          case 'ask_consult': {
            for (const h of action.hypotheses) recordHypothesis(state, h, 'agent');
            attach.turnDescriptions[state.step] = `asks: ${truncate(action.question, 60)}`;
            pendingQuestion = action.question;
            agentRequest = 'consult';
            break;
          }
          case 'give_up': {
            attach.turnDescriptions[state.step] = `gives up: ${truncate(action.reason, 60)}`;
            recordObservation(state, { source: 'agent', content: `gave up: ${action.reason}`, success: false });
            agentRequest = 'give_up';
            break;
          }
          case 'malformed': {
            const cutOff = turn.response.finishReason === 'length';
            attach.turnDescriptions[state.step] = cutOff ? 'response cut off' : 'malformed response';
            // Fixed message so repeated malformed output shares one signature and counts as a repeat.
            recordFailure(state, { toolName: 'agent', message: cutOff ? 'response truncated by output limit' : 'unparseable action', kind: 'malformed_action' });
            // Keep a sample of what the model actually said: benchmark reports collect error events.
            tracer.logEvent(traceId, 'error', { type: cutOff ? 'response_truncated' : 'malformed_action', step: state.step, model: turn.response.model, message: truncate(action.raw, 400) });
            recordObservation(state, { source: 'agent', content: `${cutOff ? 'truncated' : 'unparseable'} response: ${truncate(action.raw, 200)}`, success: false });
            pendingUser.push(cutOff
              ? 'Your last response was cut off by the output limit. Respond again with a shorter, complete JSON object (keep "answer" under 400 words).'
              : 'Your last response was not a valid action. Respond with ONLY one raw JSON object using one of the allowed forms.');
            agentRequest = 'malformed';
            break;
          }
        }
      }

      // POLICY
      state.budget = usage();
      const confidence = this.engine.compute(state, state.budget);
      if (cfg.confidenceSource === 'self-report') {
        // Ablation: the model's own claim replaces the evidence-based composite.
        // Sub-signals stay in the record so the two can be compared afterwards.
        confidence.selfReported = selfReported ?? 0.5;
        confidence.composite = confidence.selfReported;
      }
      const decision = this.policy.evaluate({
        state,
        confidence,
        agentRequest,
        llmAvailable: nextTier() !== undefined,
        atTopRung: nextTier() === undefined,
        canEscalate: budget.canAffordEscalation(envelope),
        canAfford: need => budget.canAfford(envelope, need),
        estimatedConsultCostUsd: consultCost(),
        estimatedHandoffCostUsd: handoffCost(),
        minTurnTokens: MIN_TURN_TOKENS,
      });
      if (state.status === 'completed') {
        decision.action = 'continue';
        decision.reason = 'final answer';
      }
      if (decision.action === 'continue' && activeConsultId) decision.consultId = activeConsultId;

      // Act on the decision.
      let appliedEdits: StepResult[] = [];
      switch (decision.action) {
        case 'consult': {
          const advisor = nextTier() ?? topTier;
          const advice = await this.doConsult(state, envelope, traceId, pendingQuestion, advisor, onProgress);
          decision.consultId = advice.consultId;
          decision.reason = `${decision.reason} → consult ${advisor}`;
          activeConsultId = advice.consultId;
          pendingQuestion = undefined;
          if (advice.edits && advice.edits.length > 0) {
            appliedEdits = await this.applyEdits(advice, state, envelope, traceId, advisor);
          }
          pendingUser.push(adviceBlock(advice), appliedEdits.length > 0
            ? 'The edit is in place. Verify it (run the checks) and continue. Respond with the next action as JSON.'
            : 'Apply the advice and continue. Respond with the next action as JSON.');
          break;
        }
        case 'handoff': {
          budget.deductEscalation(envelope);
          const fromTier = state.tier;
          // Climb one rung on evidence. A reasoning breakdown (repeated malformed
          // output, or giving up before any step succeeded) may skip to the top
          // rung when configured; by default it climbs one rung like any other
          // handoff, because the middle rung usually solves part of what the
          // small model cannot at a fraction of the top rung's price.
          const lf = lastFailure(state);
          const breakdown = cfg.breakdownSkipsToTop && ((lf?.kind === 'malformed_action' && lf.count >= 2)
            || (agentRequest === 'give_up' && !state.completedSteps.some(s => s.success)));
          const target = breakdown ? topTier : (nextTier() ?? topTier);
          rung = ladder.indexOf(target);
          state.tier = target;
          decision.reason = `${decision.reason} → handoff ${target}${breakdown && target !== nextTier() ? ' (skipped rung)' : ''}`;
          state.handoffs++;
          state.handoffAtStep = state.step;
          activeConsultId = undefined;
          const unresolved = pendingQuestion ? [pendingQuestion] : [];
          pendingQuestion = undefined;
          state.budget = usage();
          const handoff = toHandoffContext(state, unresolved);
          messages = [{ role: 'user', content: `${renderHandoff(handoff)}\n\nRespond with the next action as JSON.` }];
          pendingUser = [];
          tracer.logEvent(traceId, 'handoff', {
            step: state.step,
            fromTier,
            toTier: target,
            reason: decision.reason,
            completedSteps: handoff.completedWork.length,
            failures: handoff.failures.length,
          });
          onProgress?.({ phase: 'recovering', stepIndex: state.step, totalSteps: cfg.maxSteps, usage: state.budget, state: 'recover' });
          break;
        }
        case 'abort': {
          state.status = 'aborted';
          state.error = decision.reason;
          break;
        }
        case 'continue': {
          if (agentRequest === 'consult') {
            pendingUser.push('Consultation is not available right now. Decide using your best judgement and continue. Respond with the next action as JSON.');
            pendingQuestion = undefined;
          } else if (agentRequest === 'give_up') {
            pendingUser.push('Giving up is not accepted yet. Try a different approach with the available tools. Respond with the next action as JSON.');
          }
          break;
        }
      }

      recordDecision(state, decision);
      this.logDecision(traceId, decision, stepResult, attach.turnDescriptions[state.step]);
      state.step++;

      // Edits a consultation applied are steps of their own (one decision each),
      // so the trajectory and the failure rules see them like any other step.
      for (const edit of appliedEdits) {
        edit.stepIndex = state.step;
        const tool = edit.toolName;
        const path = String(edit.toolArgs.path ?? '');
        if (edit.success) {
          recordObservation(state, { source: 'consult', toolName: tool, content: `edit applied to ${path}`, success: true });
          if (edit.verifierKind === 'static_check') {
            recordObservation(state, { source: 'verifier', toolName: tool, content: `static_check: ${edit.verifyEvidence ?? ''}`, success: edit.verified === true });
            if (edit.verified === false) recordFailure(state, { toolName: tool, message: `static check: ${edit.verifyEvidence ?? 'does not compile'}`, kind: 'static_check_failed' });
          }
        } else {
          recordFailure(state, { toolName: tool, message: edit.error ?? 'edit failed', kind: 'tool_error' });
          recordObservation(state, { source: 'consult', toolName: tool, content: `edit to ${path} failed: ${edit.error ?? 'unknown error'}`, success: false });
        }
        recordStep(state, edit);
        attach.stepResults.push(edit);
        attach.turnDescriptions[state.step] = edit.description ?? 'consult edit';
        pendingUser.push(this.observationMessage(edit));
        const editDecision: EscalationDecision = {
          step: state.step, action: 'continue', score: decision.score, reason: `edit applied by consult ${activeConsultId}`,
          confidence: decision.confidence, tier: state.tier, consultId: activeConsultId, timestamp: new Date().toISOString(),
        };
        recordDecision(state, editDecision);
        this.logDecision(traceId, editDecision, edit, edit.description);
        state.step++;
      }
    }

    // ── Finish ──────────────────────────────────────────────────────
    state.budget = usage();
    const status: TaskStatus = state.status === 'completed' ? 'completed' : 'failed';
    if (state.status !== 'completed' && !state.error) state.error = 'execution stopped without a result';
    tracer.logEvent(traceId, 'info', {
      type: 'adaptive_end',
      status,
      steps: state.step,
      consultations: state.consultations,
      handoffs: state.handoffs,
      ladder,
      llmPricePerToken: attach.llmPricePerToken,
    });
    onProgress?.({ phase: 'synthesizing', stepIndex: state.step, totalSteps: state.step, usage: state.budget, state: 'synthesize' });

    return {
      status,
      result: state.result ?? this.partialResult(state),
      error: state.status === 'completed' ? undefined : state.error,
      state,
      llmPricePerToken: attach.llmPricePerToken,
    };
  }

  /**
   * The rungs this run may use, lowest first. Pinned modes get a single rung;
   * adaptive uses the configured ladder minus rungs no provider serves.
   */
  private resolveLadder(mode: ExecutionMode, probes: Map<ModelTier, TierProbe>): ModelTier[] {
    const available = (t: ModelTier): boolean => probes.get(t)?.available === true;
    const pinned: Partial<Record<ExecutionMode, ModelTier>> = {
      'slm-only': ModelTier.SLM,
      'mid-only': ModelTier.MID,
      'llm-only': ModelTier.LLM,
    };
    const single = pinned[mode];
    if (single) {
      if (!available(single)) throw new Error(`${mode} mode requires a ${single}-tier provider`);
      return [single];
    }
    const configured = this.policy.config.ladder.length > 0 ? this.policy.config.ladder : [...TIER_ORDER];
    const ladder = configured.filter(available);
    if (ladder.length === 0) throw new Error('No model provider is available for any tier in the ladder');
    return ladder;
  }

  // ── Tool execution and verification ─────────────────────────────

  private async executeTool(
    action: Extract<AgentAction, { type: 'tool_call' }>,
    state: ExecutionState,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    turn: StepAgentTurn,
    consultId: string | undefined,
  ): Promise<StepResult> {
    const { tools, tracer, budget } = this.deps;
    const base: StepResult = {
      stepIndex: state.step,
      toolName: action.toolName,
      toolArgs: action.toolArgs,
      output: undefined,
      success: false,
      durationMs: 0,
      description: action.description,
      model: turn.response.model,
      tier: state.tier,
      consultId,
    };

    if (!tools.has(action.toolName)) {
      const error = `Tool not found: ${action.toolName}`;
      recordFailure(state, { toolName: action.toolName, message: error, kind: 'missing_tool' });
      const result = { ...base, error };
      recordStep(state, result);
      recordObservation(state, { source: 'tool', toolName: action.toolName, content: error, success: false });
      return result;
    }

    budget.deductToolCall(envelope);
    const spanId = tracer.startSpan(traceId, `step-${state.step}`, { tool: action.toolName, description: action.description });
    let result: StepResult;
    try {
      const invocation = { toolName: action.toolName, input: action.toolArgs };
      const toolResult = await tools.invoke(invocation);
      tracer.logToolCall(traceId, invocation, toolResult);
      result = { ...base, output: toolResult.output, success: toolResult.success, durationMs: toolResult.durationMs, error: toolResult.error };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result = { ...base, error };
    } finally {
      tracer.endSpan(traceId, spanId);
    }

    if (!result.success) {
      recordFailure(state, { toolName: action.toolName, message: result.error ?? 'unknown error', kind: 'tool_error' });
      recordObservation(state, { source: 'tool', toolName: action.toolName, content: result.error ?? 'unknown error', success: false });
    } else {
      recordObservation(state, { source: 'tool', toolName: action.toolName, content: stringifyOutput(result.output), success: true });
    }

    // VERIFY — deterministic by default; auto-checks command exit codes even without a declared verifier.
    // A failed tool call is already one failure; verifying its (absent) output would count it twice.
    const cfg = this.policy.config;
    let outcome = result.success && cfg.verification !== 'none'
      ? await this.verifier.verify(action.verify, result)
      : { passed: false, evidence: 'tool call failed', kind: 'none' };
    // STATIC CHECK — a source file that was just written must at least parse.
    if (result.success && outcome.kind === 'none' && cfg.staticChecks && cfg.verification !== 'none') {
      const written = writtenPath(action.toolArgs, result.output);
      if (written) outcome = await staticCheck(written);
    }
    if (outcome.kind !== 'none') {
      result.verified = outcome.passed;
      result.verifierKind = outcome.kind;
      result.verifyEvidence = outcome.evidence;
      if (outcome.score !== undefined) result.verifyScore = outcome.score;
      tracer.logEvent(traceId, 'step_verified', { step: state.step, kind: outcome.kind, passed: outcome.passed, score: outcome.score, evidence: outcome.evidence });
      recordObservation(state, { source: 'verifier', toolName: action.toolName, content: `${outcome.kind}: ${outcome.evidence}`, success: outcome.passed });
      if (!outcome.passed) {
        recordFailure(state, {
          toolName: action.toolName,
          message: outcome.kind === 'static_check' ? `static check: ${outcome.evidence}` : `verification (${outcome.kind}): ${outcome.evidence}`,
          kind: outcome.kind === 'static_check' ? 'static_check_failed' : 'verification_failed',
        });
      }
    }

    recordStep(state, result);
    return result;
  }

  /**
   * Apply the edits a patch-mode consultation proposed, through the same write
   * tool the agent uses (so sandboxing and tracing apply). Each applied edit
   * becomes a step attributed to the advisor's tier; the static check runs on
   * it like on any other write. Edits that cannot be applied (unknown file,
   * search text not found) are dropped and reported in the advice.
   */
  private async applyEdits(
    advice: Advice,
    state: ExecutionState,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    advisor: ModelTier,
  ): Promise<StepResult[]> {
    const { tools, tracer, budget } = this.deps;
    const tool = writeToolName(state);
    if (!tools.has(tool)) return [];
    const known = new Map(currentFiles(state, Number.MAX_SAFE_INTEGER).map(f => [f.path, f.content]));
    const goalFile = state.goal.match(/"([^"]+\.[A-Za-z0-9]+)"/)?.[1];
    const out: StepResult[] = [];
    let applied = 0;

    for (const edit of advice.edits ?? []) {
      const content = resolveEdit(edit, known.get(edit.path));
      const allowed = known.has(edit.path) || edit.path === goalFile;
      if (content === undefined || !allowed) {
        tracer.logEvent(traceId, 'info', { type: 'consult_edit_skipped', consultId: advice.consultId, path: edit.path, reason: !allowed ? 'file not in scope' : 'search text not found' });
        continue;
      }
      budget.deductToolCall(envelope);
      const invocation = { toolName: tool, input: { path: edit.path, content } };
      const started = Date.now();
      const step: StepResult = {
        stepIndex: state.step, toolName: tool, toolArgs: invocation.input, output: undefined, success: false, durationMs: 0,
        description: `consult ${advice.consultId}: applied edit to ${basename(edit.path)}`, model: advice.model, tier: advisor, consultId: advice.consultId,
      };
      try {
        const r = await tools.invoke(invocation);
        tracer.logToolCall(traceId, invocation, r);
        Object.assign(step, { output: r.output, success: r.success, durationMs: r.durationMs, error: r.error });
      } catch (err) {
        step.error = err instanceof Error ? err.message : String(err);
        step.durationMs = Date.now() - started;
      }
      if (step.success) {
        known.set(edit.path, content);
        applied++;
        if (this.policy.config.staticChecks) {
          const check = await staticCheck(writtenPath(invocation.input, step.output) ?? edit.path);
          if (check.kind !== 'none') {
            step.verified = check.passed;
            step.verifierKind = check.kind;
            step.verifyEvidence = check.evidence;
          }
        }
      }
      // State bookkeeping (observations, failures) happens when the edit becomes a step of its own.
      out.push(step);
    }
    advice.appliedEdits = applied;
    tracer.logEvent(traceId, 'info', { type: 'consult_edits', consultId: advice.consultId, proposed: advice.edits?.length ?? 0, applied });
    return out;
  }

  // ── CONSULT ─────────────────────────────────────────────────────

  private async doConsult(
    state: ExecutionState,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    question: string | undefined,
    advisor: ModelTier,
    onProgress?: ProgressCallback,
  ): Promise<Advice> {
    const consultId = `c${state.consultations + 1}`;
    const q = question ?? this.autoQuestion(state);
    const req = toConsultationRequest(state, q, consultId, this.policy.config.consultMaxTokens, { files: this.policy.config.consultMode === 'patch' });
    onProgress?.({ phase: 'recovering', stepIndex: state.step, totalSteps: this.policy.config.maxSteps, usage: state.budget, state: 'recover' });
    const advice = await this.consultant.consult(req, envelope, traceId, advisor);
    advice.step = state.step;
    state.advice.push(advice);
    state.consultations++;
    recordObservation(state, { source: 'consult', content: `advice ${consultId}: ${advice.answer}` });
    return advice;
  }

  /** When the policy decides to consult without the agent asking, phrase the question from the evidence. */
  private autoQuestion(state: ExecutionState): string {
    const last = state.failures[state.failures.length - 1];
    const plan = currentPlan(state);
    if (last) {
      return `While working on "${state.goal}", the step using ${last.toolName} keeps failing${last.count > 1 ? ` (x${last.count})` : ''} with: ${last.message}. What should be done differently to get past this?${plan.length ? ` Remaining plan: ${plan.join('; ')}.` : ''}`;
    }
    return `Progress on "${state.goal}" has stalled. Given the evidence, what is the most likely next step that would move it forward?`;
  }

  // ── Prompts ─────────────────────────────────────────────────────

  private initialMessage(task: Task, envelope: BudgetEnvelopeInstance): string {
    const u = this.deps.budget.getUsage(envelope);
    const parts = [`TASK:\n${task.description}`];
    if (task.messages && task.messages.length > 0) {
      const history = task.messages.slice(-6).map(m => `${m.role}: ${truncate(m.content, 300)}`).join('\n');
      parts.push(`CONVERSATION SO FAR:\n${history}`);
    }
    parts.push(`BUDGET: about ${Math.max(0, u.toolCallsRemaining)} tool calls and $${Math.max(0, u.costRemaining).toFixed(3)}.`);
    parts.push('Begin. Respond with your first action as JSON (include a short "plan").');
    return parts.join('\n\n');
  }

  private observationMessage(r: StepResult): string {
    const status = r.success ? 'ok' : 'error';
    const verify = r.verified === undefined ? 'none' : r.verified ? 'pass' : 'fail';
    const body = r.success ? truncate(stringifyOutput(visibleOutput(r.output)), this.policy.config.observationChars) : (r.error ?? 'unknown error');
    const lines = [`<observation step="${r.stepIndex + 1}" tool="${r.toolName}" status="${status}" verify="${verify}">`, sanitize(body)];
    if (r.verified === false) {
      lines.push(r.verifierKind === 'static_check' ? `[static check failed: ${r.verifyEvidence ?? 'file does not compile'}]` : `[verification failed via ${r.verifierKind}]`);
    }
    lines.push('</observation>', 'Respond with the next action as JSON.');
    return lines.join('\n');
  }

  private partialResult(state: ExecutionState): string | undefined {
    const ok = state.completedSteps.filter(s => s.success);
    if (ok.length === 0) return undefined;
    return `[Partial result — ${state.status}${state.error ? `: ${state.error}` : ''}]\n${ok
      .map(s => `Step ${s.stepIndex + 1} (${s.toolName}): ${truncate(stringifyOutput(s.output), 300)}`)
      .join('\n')}`;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async probe(tier: ModelTier, envelope: BudgetEnvelopeInstance): Promise<TierProbe> {
    try {
      const decision = await this.deps.router.route('execute', envelope, { forceTier: tier });
      const pricing = MODEL_PRICING[decision.model];
      const pricePerToken = pricing
        ? (pricing.inputPerMillion + pricing.outputPerMillion) / 2 / 1_000_000
        : decision.estimatedCost > 0 ? decision.estimatedCost / 1000 : undefined;
      return { available: true, pricePerToken };
    } catch {
      return { available: false };
    }
  }

  private logDecision(traceId: string, d: EscalationDecision, step: StepResult | undefined, description?: string): void {
    this.deps.tracer.logEvent(traceId, 'escalation_decision', {
      step: d.step,
      action: d.action,
      score: d.score,
      reason: d.reason,
      confidence: d.confidence,
      tier: d.tier,
      estimatedCostUsd: d.estimatedCostUsd,
      consultId: d.consultId,
      description: description ?? step?.description,
      toolName: step?.toolName,
      success: step ? step.success : d.action !== 'abort',
      verified: step?.verified,
    });
  }
}

/**
 * The file a write-style tool call produced, when the call names one. A tool
 * that edits in place reports `written: true` and the host path to check.
 */
function writtenPath(args: Record<string, unknown>, output: unknown): string | undefined {
  const o = output && typeof output === 'object' ? (output as { path?: unknown; written?: unknown }) : undefined;
  if (typeof args.content !== 'string' && o?.written !== true) return undefined;
  if (typeof o?.path === 'string' && o.path) return o.path;
  return typeof args.path === 'string' && args.path ? args.path : undefined;
}

/** A step that changed a file: a write tool call, or an edit tool reporting `written: true`. */
function isWriteStep(s: StepResult): boolean {
  if (typeof s.toolArgs?.path === 'string' && typeof s.toolArgs?.content === 'string') return true;
  const o = s.output && typeof s.output === 'object' ? (s.output as { written?: unknown }) : undefined;
  return o?.written === true;
}

/** Tool output as the agent sees it: keys starting with '_' are bookkeeping for the executor, not for the prompt. */
function visibleOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const entries = Object.entries(output as Record<string, unknown>).filter(([k]) => !k.startsWith('_'));
  return Object.fromEntries(entries);
}

/** Whole-file content after applying a consult edit; undefined when it cannot be applied. */
function resolveEdit(edit: ConsultEdit, current: string | undefined): string | undefined {
  if (typeof edit.content === 'string') return edit.content;
  if (edit.search === undefined || edit.replace === undefined || current === undefined) return undefined;
  const first = current.indexOf(edit.search);
  if (first < 0) {
    // Tolerate indentation drift: retry with the search block's lines trimmed on the right.
    const loose = edit.search.split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    const i = current.indexOf(loose);
    return i >= 0 && current.indexOf(loose, i + 1) < 0 ? current.slice(0, i) + edit.replace + current.slice(i + loose.length) : undefined;
  }
  if (current.indexOf(edit.search, first + 1) >= 0) return undefined;
  return current.slice(0, first) + edit.replace + current.slice(first + edit.search.length);
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function cleanDescription(description: string): string {
  return description.split('\n\n[Agent Memory Context]')[0].split('\n\n[Known Failure Patterns]')[0].trim();
}

function sanitize(text: string): string {
  return text.replace(/<\/?observation[^>]*>/gi, m => m.replace('<', '&lt;').replace('>', '&gt;'));
}
