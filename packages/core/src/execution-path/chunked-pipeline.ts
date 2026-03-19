/**
 * ChunkedPipeline (P3)
 *
 * For tasks with long inputs that can be decomposed into parallel sub-tasks.
 * Splits input → parallel SLM calls → combine.
 *
 * Energy: ~0.0004 Wh vs ~0.001 Wh for full planned execution (2.5x cheaper).
 * Applicable: summarization, document analysis, long-form extraction.
 */

import type { ModelRouter } from '../model-router.js';
import type { BudgetEnvelopeInstance } from '../budget-manager.js';
import type { BudgetManager } from '../budget-manager.js';
import type { TraceLogger } from '../trace-logger.js';
import type { TaskTemplate } from '@joule/shared';
import { fillTemplate } from './template-library.js';

const DEFAULT_CHUNK_SIZE = 500; // tokens (approx 375 words)
const WORDS_PER_TOKEN = 0.75;

export interface ChunkedResult {
  output: string;
  chunks: number;
  totalTokensUsed: number;
  energyWh: number;
  latencyMs: number;
}

export class ChunkedPipeline {
  constructor(
    private readonly router: ModelRouter,
    private readonly budget: BudgetManager,
    private readonly tracer: TraceLogger,
  ) {}

  /**
   * Execute a chunked pipeline for a long-form task.
   * Splits the input text, runs parallel SLM calls, combines results.
   */
  async execute(
    description: string,
    template: TaskTemplate,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<ChunkedResult> {
    const start = Date.now();
    const chunkSize = template.chunkSize ?? DEFAULT_CHUNK_SIZE;

    // Extract the main text body from the description
    const textBody = this.extractTextBody(description);
    const chunks = this.splitIntoChunks(textBody, chunkSize);

    this.tracer.logEvent(traceId, 'info', {
      type: 'chunked_pipeline_start',
      totalChunks: chunks.length,
      chunkSize,
      totalWords: textBody.split(/\s+/).length,
    });

    const decision = await this.router.route('execute', envelope, { complexity: 0.2 });

    let totalTokens = 0;
    let totalCost = 0;

    // Execute all chunks (sequential to avoid budget race conditions,
    // but each call is a fast SLM call so total latency is still low)
    const chunkResults: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkPrompt = template.chunkPrompt
        ? template.chunkPrompt.replace('{chunk}', chunks[i])
        : `Summarize this section concisely:\n\n${chunks[i]}`;

      const { ModelProviderRegistry } = await import('@joule/models');
      const provider = ModelProviderRegistry.get(decision.provider);

      const response = await provider.complete({
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier,
        messages: [{ role: 'user', content: chunkPrompt }],
        maxTokens: 300,
        temperature: 0,
      });

      this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budget.deductCost(envelope, response.costUsd);
      totalTokens += response.tokenUsage.totalTokens;
      totalCost += response.costUsd;

      chunkResults.push(response.content.trim());
    }

    // Combine chunk results
    let finalOutput: string;

    if (chunks.length === 1) {
      finalOutput = chunkResults[0];
    } else {
      const combinePrompt = template.combinePrompt
        ? template.combinePrompt.replace('{summaries}', chunkResults.map((r, i) => `[Part ${i + 1}]: ${r}`).join('\n\n'))
        : `Combine these summaries into one coherent response:\n\n${chunkResults.map((r, i) => `[Part ${i + 1}]: ${r}`).join('\n\n')}`;

      const { ModelProviderRegistry } = await import('@joule/models');
      const provider = ModelProviderRegistry.get(decision.provider);

      const combineResponse = await provider.complete({
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier,
        messages: [{ role: 'user', content: combinePrompt }],
        maxTokens: 500,
        temperature: 0,
      });

      this.budget.deductTokens(envelope, combineResponse.tokenUsage.totalTokens, combineResponse.model);
      this.budget.deductCost(envelope, combineResponse.costUsd);
      totalTokens += combineResponse.tokenUsage.totalTokens;

      finalOutput = combineResponse.content.trim();
    }

    const latencyMs = Date.now() - start;
    // Energy model: same as benchmark (prompt*0.3 + completion*1.2) / 1e6 Wh
    const energyWh = totalTokens * 0.00000075; // simplified average

    this.tracer.logEvent(traceId, 'info', {
      type: 'chunked_pipeline_complete',
      chunks: chunks.length,
      totalTokens,
      latencyMs,
      energyWh,
    });

    return {
      output: finalOutput,
      chunks: chunks.length,
      totalTokensUsed: totalTokens,
      energyWh,
      latencyMs,
    };
  }

  /**
   * Run a template directly (P2) — single SLM call with filled template.
   */
  async executeTemplate(
    description: string,
    template: TaskTemplate,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<string> {
    const prompt = fillTemplate(template, description);
    const decision = await this.router.route('execute', envelope, { complexity: 0.2 });

    const { ModelProviderRegistry } = await import('@joule/models');
    const provider = ModelProviderRegistry.get(decision.provider);

    const response = await provider.complete({
      model: decision.model,
      provider: decision.provider,
      tier: decision.tier,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 800,
      temperature: 0,
    });

    this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
    this.budget.deductCost(envelope, response.costUsd);

    this.tracer.logEvent(traceId, 'info', {
      type: 'template_executed',
      templateKey: template.key,
      tokensUsed: response.tokenUsage.totalTokens,
    });

    return response.content.trim();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Extract the main text from a task description (after any preamble) */
  private extractTextBody(description: string): string {
    // If description contains a code block, extract it
    const codeMatch = description.match(/```[\w]*\n?([\s\S]+?)```/);
    if (codeMatch) return codeMatch[1];

    // If there's a colon separator (e.g. "Summarize this: <text>")
    const colonIdx = description.indexOf(':');
    if (colonIdx > 0 && colonIdx < 80) {
      return description.slice(colonIdx + 1).trim();
    }

    return description;
  }

  /** Split text into roughly equal chunks of `targetTokens` each */
  private splitIntoChunks(text: string, targetTokens: number): string[] {
    const targetWords = Math.round(targetTokens * WORDS_PER_TOKEN);
    const words = text.split(/\s+/);

    if (words.length <= targetWords) {
      return [text];
    }

    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += targetWords) {
      chunks.push(words.slice(i, i + targetWords).join(' '));
    }
    return chunks;
  }
}
