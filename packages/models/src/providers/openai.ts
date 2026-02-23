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
  readonly supportedTiers = [ModelTier.SLM, ModelTier.LLM];

  private client: OpenAI;
  private slmModel: string;
  private llmModel: string;

  constructor(config: { apiKey: string; slmModel?: string; llmModel?: string }) {
    super();
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.slmModel = config.slmModel ?? 'gpt-4o-mini';
    this.llmModel = config.llmModel ?? 'gpt-4o';
  }

  async isAvailable(): Promise<boolean> {
    return true;
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
      ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    });

    const latencyMs = monotonicNow() - startTime;
    const choice = response.choices[0];
    const tokenUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };

    return {
      model: request.model,
      provider: 'openai',
      tier: request.tier,
      content: choice?.message?.content ?? '',
      tokenUsage,
      latencyMs,
      costUsd: this.calculateCost(request.model, tokenUsage),
      finishReason: choice?.finish_reason === 'stop' ? 'stop' : 'length',
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
