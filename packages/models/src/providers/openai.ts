import OpenAI from 'openai';
import {
  ModelTier,
  type ModelRequest,
  type ModelResponse,
  type ModelProviderName,
  type ModelInfo,
  MODEL_PRICING,
  MODEL_ENERGY,
  monotonicNow,
} from '@joule/shared';
import { getModelEnergy } from '../pricing.js';
import { ModelProvider, type StreamChunk } from '../provider.js';

export class OpenAIProvider extends ModelProvider {
  readonly name: ModelProviderName = 'openai';
  readonly supportedTiers: ModelTier[] = [ModelTier.SLM, ModelTier.LLM];

  private client: OpenAI;
  private slmModel: string;
  private llmModel: string;
  /** Optional middle rung (efficient large model) for the escalation ladder */
  private midModel?: string;

  private jsonMode: boolean;
  private extraBody: Record<string, unknown>;
  private extraBodyByModel: Record<string, Record<string, unknown>>;
  private logprobs: boolean;
  private openRouter: boolean;

  /**
   * `baseUrl` points the client at any OpenAI-compatible endpoint (OpenRouter,
   * vLLM, LM Studio). `jsonMode: false` skips `response_format` for endpoints
   * or models that reject it; prompts still ask for JSON.
   *
   * `extraBody` / `extraBodyByModel` are merged into every request body: the
   * place for provider-specific knobs such as OpenRouter's `reasoning`
   * settings. `logprobs: true` asks for token log-probabilities (models that do
   * not support them fail the request, so it is opt-in). When the endpoint
   * reports the billed cost (OpenRouter's `usage.cost`), it is used instead of
   * the local price table.
   */
  constructor(config: {
    apiKey: string; slmModel?: string; midModel?: string; llmModel?: string; baseUrl?: string; jsonMode?: boolean;
    defaultHeaders?: Record<string, string>; extraBody?: Record<string, unknown>; extraBodyByModel?: Record<string, Record<string, unknown>>; logprobs?: boolean;
  }) {
    super();
    this.client = new OpenAI({ apiKey: config.apiKey, ...(config.baseUrl ? { baseURL: config.baseUrl } : {}), ...(config.defaultHeaders ? { defaultHeaders: config.defaultHeaders } : {}) });
    this.jsonMode = config.jsonMode ?? true;
    this.extraBody = config.extraBody ?? {};
    this.extraBodyByModel = config.extraBodyByModel ?? {};
    this.logprobs = config.logprobs ?? false;
    this.openRouter = (config.baseUrl ?? '').includes('openrouter');
    this.slmModel = config.slmModel ?? 'gpt-4o-mini';
    this.llmModel = config.llmModel ?? 'gpt-4o';
    this.midModel = config.midModel;
    if (this.midModel) this.supportedTiers = [ModelTier.SLM, ModelTier.MID, ModelTier.LLM];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  /** Provider-specific request fields (e.g. OpenRouter `reasoning`), global then per model. */
  private extra(model: string): Record<string, unknown> {
    return { ...this.extraBody, ...(this.extraBodyByModel[model] ?? {}) };
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    const startTime = monotonicNow();

    const hasImages = request.messages.some(m => m.images?.length);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    for (const msg of request.messages) {
      if (msg.images?.length) {
        messages.push({
          role: msg.role,
          content: [
            ...msg.images.map(img => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            })),
            { type: 'text' as const, text: msg.content },
          ],
        });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    const response = await this.client.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? (hasImages ? 4096 : 1024),
      temperature: request.temperature ?? 0.1,
      ...(request.responseFormat === 'json' && this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(this.logprobs ? { logprobs: true } : {}),
      ...(this.openRouter ? { usage: { include: true } } : {}),
      ...(this.extra(request.model) as object),
    });

    const latencyMs = monotonicNow() - startTime;
    const choice = response.choices[0];
    // Prompt-cache reads: OpenAI and OpenRouter report prompt_tokens_details, DeepSeek's own API prompt_cache_hit_tokens.
    const cacheUsage = response.usage as { prompt_tokens_details?: { cached_tokens?: number } | null; prompt_cache_hit_tokens?: number } | undefined;
    const cachedPromptTokens = cacheUsage?.prompt_tokens_details?.cached_tokens ?? cacheUsage?.prompt_cache_hit_tokens ?? 0;
    const tokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
      ...(cachedPromptTokens > 0 ? { cachedPromptTokens } : {}),
    };
    const reported = (response.usage as { cost?: unknown } | undefined)?.cost;
    const costUsd = typeof reported === 'number' && reported > 0 ? reported : this.calculateCost(request.model, tokenUsage);
    const lps = (choice as { logprobs?: { content?: Array<{ logprob: number }> | null } | null } | undefined)?.logprobs?.content;
    const meanLogprob = lps && lps.length > 0 ? lps.reduce((a, t) => a + t.logprob, 0) / lps.length : undefined;

    return {
      model: request.model,
      provider: 'openai',
      tier: request.tier,
      content: choice?.message?.content ?? '',
      tokenUsage,
      latencyMs,
      costUsd,
      finishReason: choice?.finish_reason === 'stop' ? 'stop' : 'length',
      ...(meanLogprob !== undefined ? { meanLogprob } : {}),
      energyWh: getModelEnergy(request.model, tokenUsage),
    };
  }

  async *chatStream(request: ModelRequest): AsyncGenerator<StreamChunk> {
    const hasImages = request.messages.some(m => m.images?.length);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: any }> = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    for (const msg of request.messages) {
      if (msg.images?.length) {
        messages.push({
          role: msg.role,
          content: [
            ...msg.images.map(img => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            })),
            { type: 'text' as const, text: msg.content },
          ],
        });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    const stream = await this.client.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? (hasImages ? 4096 : 1024),
      temperature: request.temperature ?? 0.1,
      stream: true,
      stream_options: { include_usage: true },
      ...(this.extra(request.model) as object),
    });

    let lastTokenUsage: StreamChunk['tokenUsage'] | undefined;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      const finishReason = chunk.choices?.[0]?.finish_reason;

      // Capture usage from the final chunk
      if (chunk.usage) {
        lastTokenUsage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }

      if (finishReason) {
        yield {
          content: delta?.content ?? '',
          done: true,
          tokenUsage: lastTokenUsage,
          finishReason: finishReason === 'stop' ? 'stop' : 'length',
        };
      } else if (delta?.content) {
        yield {
          content: delta.content,
          done: false,
        };
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: this.slmModel,
        name: 'GPT-4o Mini',
        tier: ModelTier.SLM,
        contextWindow: 128_000,
        costPerInputToken: (MODEL_PRICING[this.slmModel]?.inputPerMillion ?? 0.15) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.slmModel]?.outputPerMillion ?? 0.60) / 1_000_000,
        energyPerInputToken: (MODEL_ENERGY[this.slmModel]?.inputWhPerMillion ?? 0) / 1_000_000,
        energyPerOutputToken: (MODEL_ENERGY[this.slmModel]?.outputWhPerMillion ?? 0) / 1_000_000,
      },
      ...(this.midModel ? [{
        id: this.midModel,
        name: this.midModel,
        tier: ModelTier.MID,
        contextWindow: 200_000,
        costPerInputToken: (MODEL_PRICING[this.midModel]?.inputPerMillion ?? 1.0) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.midModel]?.outputPerMillion ?? 4.0) / 1_000_000,
        energyPerInputToken: (MODEL_ENERGY[this.midModel]?.inputWhPerMillion ?? 0) / 1_000_000,
        energyPerOutputToken: (MODEL_ENERGY[this.midModel]?.outputWhPerMillion ?? 0) / 1_000_000,
      }] : []),
      {
        id: this.llmModel,
        name: 'GPT-4o',
        tier: ModelTier.LLM,
        contextWindow: 128_000,
        costPerInputToken: (MODEL_PRICING[this.llmModel]?.inputPerMillion ?? 2.50) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.llmModel]?.outputPerMillion ?? 10.00) / 1_000_000,
        energyPerInputToken: (MODEL_ENERGY[this.llmModel]?.inputWhPerMillion ?? 0) / 1_000_000,
        energyPerOutputToken: (MODEL_ENERGY[this.llmModel]?.outputWhPerMillion ?? 0) / 1_000_000,
      },
    ];
  }

  estimateCost(promptTokens: number, model: string): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (promptTokens * (pricing.inputPerMillion + pricing.outputPerMillion)) / 1_000_000;
  }

  private calculateCost(model: string, usage: { promptTokens: number; completionTokens: number }): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (
      (usage.promptTokens * pricing.inputPerMillion +
        usage.completionTokens * pricing.outputPerMillion) /
      1_000_000
    );
  }
}
