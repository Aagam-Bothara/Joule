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
  type ConsultEdit,
  type ConsultationRequest,
  type EnergyConfig,
  type ModelRequest,
} from '@joule/shared';
import type { ModelProviderRegistry } from '@joule/models';
import type { ModelRouter } from '../model-router.js';
import type { BudgetManager, BudgetEnvelopeInstance } from '../budget-manager.js';
import type { TraceLogger } from '../trace-logger.js';
import { renderConsultation } from './execution-state.js';
import { extractJson } from './step-agent.js';

const CONSULT_SYSTEM_PROMPT = `You are a senior engineer advising a smaller model that is executing a task step by step. You are given the goal, one focused question, and the evidence gathered so far.

Answer ONLY the question. Be concrete and actionable: name the approach, the exact command or code change, and what to check afterwards. Do not restate the evidence. Do not solve the whole task. Plain text, no JSON, no markdown headings.`;

/**
 * Patch mode: the advisor answers the question AND, when the fix is a code
 * change it can state exactly, hands back the edit itself. Prose advice was
 * the weak link on long tasks: the small model often failed to turn a correct
 * description into a correct edit. An applied edit skips that step; the small
 * model still verifies and finishes, so the consultation stays one call.
 */
const CONSULT_PATCH_SYSTEM_PROMPT = `You are a senior engineer advising a smaller model that is executing a task step by step. You are given the goal, one focused question, the evidence gathered so far, and the current contents of the files involved.

Answer ONLY the question, concretely. If the right fix is a code change you can state exactly, include it as an edit; the smaller model will apply it, run the checks, and finish. Do not solve parts of the task that were not asked about.

Respond with ONLY a raw JSON object (no markdown, no code fences) of the form:
{"advice":"<short, direct answer: what to do and what to check afterwards>","edits":[{"path":"<file path exactly as shown>","content":"<complete new file content>"}]}
Rules for "edits":
- Optional; use [] when the answer is not a file change.
- Use "content" for a whole-file replacement (small files) OR {"path":..., "search":"<exact existing text>", "replace":"<new text>"} for a surgical change in a large file. "search" must match the current file exactly once.
- Only edit files listed under CURRENT FILES, or the file the goal names.
- Keep advice under 120 words.`;

export type ConsultMode = 'advice' | 'patch';

export class Consultant {
  constructor(
    private router: ModelRouter,
    private providers: ModelProviderRegistry,
    private budget: BudgetManager,
    private tracer: TraceLogger,
    private energyConfig?: EnergyConfig,
    private mode: ConsultMode = 'advice',
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

      const patch = this.mode === 'patch';
      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier,
        system: patch ? CONSULT_PATCH_SYSTEM_PROMPT : CONSULT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: renderConsultation(req) }],
        // An edit carries file content on top of the answer.
        maxTokens: patch ? Math.max(req.maxTokens, 2500) + Math.min(6000, Math.round((req.files ?? []).reduce((n, f) => n + f.content.length, 0) / 3)) : req.maxTokens,
        temperature: 0.2,
        responseFormat: patch ? 'json' : 'text',
      };

      const response = await provider.chat(request);
      const charged = this.budget.recordModelResponse(envelope, response, this.energyConfig);
      this.tracer.logModelCall(traceId, request, { ...response, costUsd: charged.costUsd });

      const parsed = patch ? parsePatchReply(response.content) : undefined;
      const advice: Advice = {
        consultId: req.consultId,
        step: 0, // filled by the executor
        question: req.question,
        answer: parsed ? parsed.advice : response.content.trim(),
        model: response.model,
        tokens: charged.tokens,
        costUsd: charged.costUsd,
        ...(parsed && parsed.edits.length > 0 ? { edits: parsed.edits } : {}),
      };

      this.tracer.logEvent(traceId, 'consultation', {
        consultId: req.consultId,
        model: response.model,
        tokens: charged.tokens,
        costUsd: charged.costUsd,
        question: req.question,
        answerChars: advice.answer.length,
        edits: advice.edits?.length ?? 0,
      });
      return advice;
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }
}

/** Lenient parse of a patch-mode reply; a reply that is not JSON is treated as plain advice. */
export function parsePatchReply(content: string): { advice: string; edits: ConsultEdit[] } {
  const obj = extractJson(content) as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== 'object') return { advice: content.trim(), edits: [] };
  const advice = typeof obj.advice === 'string' ? obj.advice.trim() : typeof obj.answer === 'string' ? obj.answer.trim() : content.trim();
  const edits: ConsultEdit[] = [];
  const raw = Array.isArray(obj.edits) ? obj.edits : [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (typeof o.path !== 'string' || !o.path) continue;
    if (typeof o.content === 'string') edits.push({ path: o.path, content: o.content });
    else if (typeof o.search === 'string' && typeof o.replace === 'string' && o.search) edits.push({ path: o.path, search: o.search, replace: o.replace });
  }
  return { advice, edits };
}
