/**
 * ExecutionPathClassifier
 *
 * A single lightweight SLM call (~150 tokens) that selects the optimal
 * execution path for a task BEFORE any expensive work begins.
 *
 * Paths (ordered by energy cost, ~4-5x apart each):
 *   P0: Cache hit     — ~0 Wh
 *   P1: Direct answer — ~0.00006 Wh
 *   P2: Template      — ~0.0002 Wh
 *   P3: Chunked       — ~0.0004 Wh
 *   P4: Planned       — ~0.001 Wh
 *   P5: Escalated     — ~0.004 Wh
 */

import type {
  ExecutionProfile,
  ExecutionPathId,
} from '@joule/shared';
import type { ModelRouter } from '../model-router.js';
import type { BudgetEnvelopeInstance } from '../budget-manager.js';
import type { BudgetManager } from '../budget-manager.js';
import type { TraceLogger } from '../trace-logger.js';
import { TEMPLATE_KEYS } from './template-library.js';

// Keywords that strongly indicate tool-using tasks (P4+)
const ACTION_KEYWORDS = [
  'open', 'browse', 'navigate', 'click', 'fetch', 'download', 'upload',
  'create file', 'write file', 'save file', 'run command', 'execute', 'install',
  'send email', 'send message', 'post', 'search the web', 'look up online',
  'play video', 'take screenshot', 'fill form', 'submit',
];

// Keywords that suggest chunked processing (P3)
const CHUNK_KEYWORDS = [
  'summarize', 'summary', 'tldr', 'brief', 'extract from', 'analyze document',
  'read this document', 'process this text', 'go through this',
];

// Max description length (chars) considered for direct answer (P1)
const DIRECT_ANSWER_MAX_LENGTH = 300;

const CLASSIFIER_SYSTEM_PROMPT = `You are an execution path classifier for an AI agent runtime. Your goal: minimize energy consumption while maintaining quality.

Classify the task to select the cheapest sufficient execution path.

Paths (ordered by energy, cheapest first):
0: CACHE — task seems repetitive or very similar to common queries
1: DIRECT — simple question/fact/greeting, no tools, single SLM call
2: TEMPLATE — structured task matching a known pattern (code, summarize, email, etc.)
3: CHUNKED — long document/text that can be split into parallel chunks
4: PLANNED — multi-step task requiring tool calls and reasoning
5: ESCALATED — complex reasoning requiring large model (only if P4 would fail)

Templates available: ${TEMPLATE_KEYS.join(', ')}

Rules:
- Default to the LOWEST numbered path that can complete the task correctly
- Only use P4/P5 if the task genuinely requires tool calls or multi-step actions
- P5 should be rare (< 5% of tasks)

Respond with ONLY valid JSON (no markdown, no code fences):
{"path": <0-5>, "confidence": <0.0-1.0>, "template": "<key or null>", "chunkSize": <tokens or null>, "modelTier": "slm|llm", "predictedEnergyWh": <number>, "predictedQuality": <1-5>, "rationale": "<one sentence>"}`;

export class ExecutionPathClassifier {
  constructor(
    private readonly router: ModelRouter,
    private readonly budget: BudgetManager,
    private readonly tracer: TraceLogger,
  ) {}

  /**
   * Classify a task description into an execution profile.
   * Falls back to heuristic classification if the SLM call fails.
   */
  async classify(
    description: string,
    toolNames: string[],
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<ExecutionProfile> {
    const start = Date.now();

    // Fast heuristic pre-screen — avoid the SLM call for obvious cases
    const heuristic = this.heuristicClassify(description, toolNames);
    if (heuristic.confidence >= 0.90) {
      this.tracer.logEvent(traceId, 'info', {
        type: 'path_classified',
        method: 'heuristic',
        path: heuristic.path,
        confidence: heuristic.confidence,
        rationale: heuristic.rationale,
        latencyMs: Date.now() - start,
      });
      return heuristic;
    }

    // SLM call for uncertain cases
    try {
      const decision = await this.router.route('classify', envelope, { complexity: 0.1 });

      const userMessage = `Task: "${description}"
Available tools: ${toolNames.join(', ')}`;

      // Import ModelProviderRegistry inline to avoid circular deps
      const { ModelProviderRegistry } = await import('@joule/models');
      const provider = ModelProviderRegistry.get(decision.provider);

      const response = await provider.complete({
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 200,
        temperature: 0,
      });

      this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budget.deductCost(envelope, response.costUsd);

      const parsed = this.parseResponse(response.content);
      if (parsed) {
        this.tracer.logEvent(traceId, 'info', {
          type: 'path_classified',
          method: 'slm',
          path: parsed.path,
          confidence: parsed.confidence,
          rationale: parsed.rationale,
          latencyMs: Date.now() - start,
          tokensUsed: response.tokenUsage.totalTokens,
        });
        return parsed;
      }
    } catch {
      // SLM call failed — fall through to heuristic
    }

    // Return heuristic as fallback
    this.tracer.logEvent(traceId, 'info', {
      type: 'path_classified',
      method: 'heuristic_fallback',
      path: heuristic.path,
      confidence: heuristic.confidence,
      rationale: heuristic.rationale,
      latencyMs: Date.now() - start,
    });
    return heuristic;
  }

  /**
   * Fast heuristic — no LLM call, pure pattern matching.
   * Returns high confidence for clear-cut cases.
   */
  heuristicClassify(description: string, toolNames: string[]): ExecutionProfile {
    const lower = description.toLowerCase();
    const hasTools = toolNames.length > 0;
    const hasActionKeywords = ACTION_KEYWORDS.some(kw => lower.includes(kw));
    const hasChunkKeywords = CHUNK_KEYWORDS.some(kw => lower.includes(kw));

    // P4: Tools are registered — task almost certainly needs them.
    // This is the highest-confidence signal available. Confidence 0.98 skips SLM call.
    if (hasTools) {
      return {
        path: 4,
        confidence: 0.98,
        modelTier: 'slm',
        predictedEnergyWh: 0.001,
        predictedQuality: 4.0,
        rationale: 'Tools registered — planned execution',
      };
    }

    // P1: No tools, no action/chunk keywords, short description → direct answer.
    // Confidence 0.97 skips SLM call.
    if (
      description.length <= DIRECT_ANSWER_MAX_LENGTH &&
      !hasActionKeywords &&
      !hasChunkKeywords
    ) {
      return {
        path: 1,
        confidence: 0.97,
        modelTier: 'slm',
        predictedEnergyWh: 0.00006,
        predictedQuality: 4.5,
        rationale: 'Short, no tools, no action keywords — direct SLM answer',
      };
    }

    // P3: Chunk keywords, no tools → chunked pipeline. Confidence 0.92 skips SLM call.
    if (hasChunkKeywords) {
      return {
        path: 3,
        confidence: 0.92,
        chunkSize: 500,
        modelTier: 'slm',
        predictedEnergyWh: 0.0004,
        predictedQuality: 4.5,
        rationale: 'Summarization/extraction, no tools — chunked pipeline',
      };
    }

    // P4: Action keywords without tools → planned execution
    if (hasActionKeywords) {
      return {
        path: 4,
        confidence: 0.90,
        modelTier: 'slm',
        predictedEnergyWh: 0.001,
        predictedQuality: 4.0,
        rationale: 'Action keywords detected — planned execution',
      };
    }

    // Default: P4 for anything unclear (will trigger SLM call)
    return {
      path: 4,
      confidence: 0.60,
      modelTier: 'slm',
      predictedEnergyWh: 0.001,
      predictedQuality: 4.0,
      rationale: 'Unclear task — defaulting to planned execution',
    };
  }

  private parseResponse(content: string): ExecutionProfile | null {
    try {
      const json = content.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(json) as {
        path: number;
        confidence: number;
        template?: string;
        chunkSize?: number;
        modelTier: string;
        predictedEnergyWh: number;
        predictedQuality: number;
        rationale: string;
      };

      const path = Math.max(0, Math.min(5, Math.round(parsed.path ?? 4))) as ExecutionPathId;
      return {
        path,
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.7)),
        template: parsed.template ?? undefined,
        chunkSize: parsed.chunkSize ?? undefined,
        modelTier: parsed.modelTier === 'llm' ? 'llm' : 'slm',
        predictedEnergyWh: parsed.predictedEnergyWh ?? 0.001,
        predictedQuality: Math.max(1, Math.min(5, parsed.predictedQuality ?? 4)),
        rationale: parsed.rationale ?? '',
      };
    } catch {
      return null;
    }
  }
}
