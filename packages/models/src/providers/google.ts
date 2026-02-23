import {
  GoogleGenerativeAI,
  type GenerateContentStreamResult,
} from '@google/generative-ai';
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

export class GoogleProvider extends ModelProvider {
  readonly name: ModelProviderName = 'google';
  readonly supportedTiers = [ModelTier.SLM, ModelTier.LLM];

  private client: GoogleGenerativeAI;
  private slmModel: string;
  private llmModel: string;

  constructor(config: { apiKey: string; slmModel?: string; llmModel?: string }) {
    super();
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.slmModel = config.slmModel ?? 'gemini-2.0-flash';
    this.llmModel = config.llmModel ?? 'gemini-2.5-pro';
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    const startTime = monotonicNow();

    const model = this.client.getGenerativeModel({
      model: request.model,
      systemInstruction: request.system || undefined,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.1,
        ...(request.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
      },
    });

    // Build contents from messages (with optional image parts)
    const contents = request.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.images?.length
        ? [
            ...m.images.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
            { text: m.content },
          ]
        : [{ text: m.content }],
    }));

    const result = await model.generateContent({ contents });
    const response = result.response;
    const latencyMs = monotonicNow() - startTime;

    const text = response.text();
    const usage = response.usageMetadata;
    const tokenUsage = {
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      totalTokens: usage?.totalTokenCount ?? 0,
    };

    return {
      model: request.model,
      provider: 'google',
      tier: request.tier,
      content: text,
      tokenUsage,
      latencyMs,
      costUsd: this.calculateCost(request.model, tokenUsage),
      finishReason: 'stop',
      energyWh: getModelEnergy(request.model, tokenUsage),
    };
  }

  async *chatStream(request: ModelRequest): AsyncGenerator<StreamChunk> {
    const model = this.client.getGenerativeModel({
      model: request.model,
      systemInstruction: request.system || undefined,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.1,
      },
    });

    const contents = request.messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: m.images?.length
        ? [
            ...m.images.map(img => ({ inlineData: { mimeType: img.mediaType, data: img.data } })),
            { text: m.content },
          ]
        : [{ text: m.content }],
    }));

    const result: GenerateContentStreamResult = await model.generateContentStream({ contents });

    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        yield {
          content: text,
          done: false,
        };
      }
    }

    // Get final aggregated response for token usage
    const aggregated = await result.response;
    const usage = aggregated.usageMetadata;

    yield {
      content: '',
      done: true,
      tokenUsage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      finishReason: 'stop',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: this.slmModel,
        name: 'Gemini 2.0 Flash',
        tier: ModelTier.SLM,
        contextWindow: 1_000_000,
        costPerInputToken: (MODEL_PRICING[this.slmModel]?.inputPerMillion ?? 0.10) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.slmModel]?.outputPerMillion ?? 0.40) / 1_000_000,
        energyPerInputToken: (MODEL_ENERGY[this.slmModel]?.inputWhPerMillion ?? 0) / 1_000_000,
        energyPerOutputToken: (MODEL_ENERGY[this.slmModel]?.outputWhPerMillion ?? 0) / 1_000_000,
      },
      {
        id: this.llmModel,
        name: 'Gemini 2.5 Pro',
        tier: ModelTier.LLM,
        contextWindow: 1_000_000,
        costPerInputToken: (MODEL_PRICING[this.llmModel]?.inputPerMillion ?? 1.25) / 1_000_000,
        costPerOutputToken: (MODEL_PRICING[this.llmModel]?.outputPerMillion ?? 5.00) / 1_000_000,
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
