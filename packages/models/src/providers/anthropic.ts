import Anthropic from '@anthropic-ai/sdk';
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

export class AnthropicProvider extends ModelProvider {
  readonly name: ModelProviderName = 'anthropic';
  readonly supportedTiers = [ModelTier.SLM, ModelTier.LLM];

  private client: Anthropic;
  private slmModel: string;
  private llmModel: string;

  constructor(config: { apiKey: string; slmModel?: string; llmModel?: string }) {
    super();
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.slmModel = config.slmModel ?? 'claude-haiku-4-5-20251001';
    this.llmModel = config.llmModel ?? 'claude-sonnet-4-20250514';
  }

  async isAvailable(): Promise<boolean> {
    return true; // Cloud provider is always "available" if configured
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    const startTime = monotonicNow();

    const hasImages = request.messages.some(m => m.images?.length);
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.images?.length
          ? [
              ...m.images.map(img => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
              })),
              { type: 'text' as const, text: m.content },
            ]
          : m.content,
      }));

    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens ?? (hasImages ? 4096 : 1024),
      ...(request.system ? { system: request.system } : {}),
      messages,
    });

    const latencyMs = monotonicNow() - startTime;
    const tokenUsage = {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
    };

    const content = response.content
      .filter(block => block.type === 'text')
      .map(block => (block as { type: 'text'; text: string }).text)
      .join('');

    return {
      model: request.model,
      provider: 'anthropic',
      tier: request.tier,
      content,
      tokenUsage,
      latencyMs,
      costUsd: this.calculateCost(request.model, tokenUsage),
      finishReason: response.stop_reason === 'end_turn' ? 'stop' : 'length',
      energyWh: getModelEnergy(request.model, tokenUsage),
    };
  }

  async *chatStream(request: ModelRequest): AsyncGenerator<StreamChunk> {
    const hasImages = request.messages.some(m => m.images?.length);
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.images?.length
          ? [
              ...m.images.map(img => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
              })),
              { type: 'text' as const, text: m.content },
            ]
          : m.content,
      }));

    const stream = this.client.messages.stream({
      model: request.model,
      max_tokens: request.maxTokens ?? (hasImages ? 4096 : 1024),
      ...(request.system ? { system: request.system } : {}),
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield {
          content: event.delta.text,
          done: false,
        };
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      content: '',
      done: true,
      tokenUsage: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
      },
      finishReason: finalMessage.stop_reason === 'end_turn' ? 'stop' : 'length',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: this.slmModel,
        name: 'Claude Haiku 3.5',
        tier: ModelTier.SLM,
        contextWindow: 200_000,
        costPerInputToken: (MODEL_PRICING[this.slmModel]?.inputPerMillion ?? 0.80) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.slmModel]?.outputPerMillion ?? 4.00) / 1_000_000,
        energyPerInputToken: (MODEL_ENERGY[this.slmModel]?.inputWhPerMillion ?? 0) / 1_000_000,
        energyPerOutputToken: (MODEL_ENERGY[this.slmModel]?.outputWhPerMillion ?? 0) / 1_000_000,
      },
      {
        id: this.llmModel,
        name: 'Claude Sonnet 4',
        tier: ModelTier.LLM,
        contextWindow: 200_000,
        costPerInputToken: (MODEL_PRICING[this.llmModel]?.inputPerMillion ?? 3.00) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.llmModel]?.outputPerMillion ?? 15.00) / 1_000_000,
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
