/**
 * Consultant — CONSULT: one focused question to the LLM, then back to the SLM.
 *
 * The LLM never sees the whole conversation. It receives a ConsultationRequest
 * built from the execution state: goal, the question, relevant evidence,
 * hypotheses, failed attempts and constraints, under a token cap.
 */

import {
  ModelTier,
  type Advice,
  type ConsultationRequest,
  type EnergyConfig,
  type ModelRequest,
} from '@joule/shared';
import type { ModelProviderRegistry } from '@joule/models';
import type { ModelRouter } from '../model-router.js';
import type { BudgetManager, BudgetEnvelopeInstance } from '../budget-manager.js';
import type { TraceLogger } from '../trace-logger.js';
import { renderConsultation } from './execution-state.js';

const CONSULT_SYSTEM_PROMPT = `You are a senior engineer advising a smaller model that is executing a task step by step. You are given the goal, one focused question, and the evidence gathered so far.

Answer ONLY the question. Be concrete and actionable: name the approach, the exact command or code change, and what to check afterwards. Do not restate the evidence. Do not solve the whole task. Plain text, no JSON, no markdown headings.`;

export class Consultant {
  constructor(
    private router: ModelRouter,
    private providers: ModelProviderRegistry,
    private budget: BudgetManager,
    private tracer: TraceLogger,
    private energyConfig?: EnergyConfig,
  ) {}

  async consult(
    req: ConsultationRequest,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    tier: ModelTier = ModelTier.LLM,
  ): Promise<Advice> {
    const spanId = this.tracer.startSpan(traceId, `consult-${req.consultId}`, { question: req.question, tier });
    try {
      const decision = await this.router.route('execute', envelope, { forceTier: tier });
      this.tracer.logRoutingDecision(traceId, { ...decision, purpose: 'consult', consultId: req.consultId } as unknown as Record<string, unknown>);
      const provider = this.providers.get(decision.provider);
      if (!provider) throw new Error(`Provider not available: ${decision.provider}`);

      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier,
        system: CONSULT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: renderConsultation(req) }],
        maxTokens: req.maxTokens,
        temperature: 0.2,
        responseFormat: 'text',
      };

      const response = await provider.chat(request);
      const charged = this.budget.recordModelResponse(envelope, response, this.energyConfig);
      this.tracer.logModelCall(traceId, request, { ...response, costUsd: charged.costUsd });

      const advice: Advice = {
        consultId: req.consultId,
        step: 0, // filled by the executor
        question: req.question,
        answer: response.content.trim(),
        model: response.model,
        tokens: charged.tokens,
        costUsd: charged.costUsd,
      };

      this.tracer.logEvent(traceId, 'consultation', {
        consultId: req.consultId,
        model: response.model,
        tokens: charged.tokens,
        costUsd: charged.costUsd,
        question: req.question,
        answerChars: advice.answer.length,
      });
      return advice;
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }
}
