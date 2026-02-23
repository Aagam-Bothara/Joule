import {
  ModelTier,
  type ModelRequest,
  type ModelResponse,
  type ModelProviderName,
  type ModelInfo,
  MODEL_ENERGY,
  monotonicNow,
} from '@joule/shared';
import { getModelEnergy } from '../pricing.js';
import { ModelProvider, type StreamChunk } from '../provider.js';

export class OllamaProvider extends ModelProvider {
  readonly name: ModelProviderName = 'ollama';
  readonly supportedTiers = [ModelTier.SLM];

  private baseUrl: string;
  private modelId: string;

  constructor(config: { baseUrl?: string; model?: string }) {
    super();
    this.baseUrl = config.baseUrl ?? 'http://localhost:11434';
    this.modelId = config.model ?? 'llama3.2:3b';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    const startTime = monotonicNow();

    const messages = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const body = {
      model: request.model || this.modelId,
      messages,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.1,
        num_predict: request.maxTokens ?? 1024,
      },
      ...(request.responseFormat === 'json' ? { format: 'json' } : {}),
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${text}`);
    }

    const data = await res.json() as OllamaChatResponse;
    const latencyMs = monotonicNow() - startTime;

    return {
      model: data.model,
      provider: 'ollama',
      tier: ModelTier.SLM,
      content: data.message?.content ?? '',
      tokenUsage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      latencyMs,
      costUsd: 0, // Local = free
      finishReason: data.done ? 'stop' : 'length',
      energyWh: getModelEnergy(data.model, {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      }),
      carbonGrams: 0, // Local = 0 carbon by default
    };
  }

  async *chatStream(request: ModelRequest): AsyncGenerator<StreamChunk> {
    const messages = [];
    if (request.system) {
      messages.push({ role: 'system', content: request.system });
    }
    for (const msg of request.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    const body = {
      model: request.model || this.modelId,
      messages,
      stream: true,
      options: {
        temperature: request.temperature ?? 0.1,
        num_predict: request.maxTokens ?? 1024,
      },
      ...(request.responseFormat === 'json' ? { format: 'json' } : {}),
    };

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama API error (${res.status}): ${text}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line) as OllamaStreamChunk;

        if (data.done) {
          yield {
            content: data.message?.content ?? '',
            done: true,
            tokenUsage: {
              promptTokens: data.prompt_eval_count ?? 0,
              completionTokens: data.eval_count ?? 0,
              totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            },
            finishReason: 'stop',
          };
        } else {
          yield {
            content: data.message?.content ?? '',
            done: false,
          };
        }
      }
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: this.modelId,
        name: this.modelId,
        tier: ModelTier.SLM,
        contextWindow: 8192,
        costPerInputToken: 0,
        costPerOutputToken: 0,
        energyPerInputToken: (MODEL_ENERGY[this.modelId]?.inputWhPerMillion ?? 0) / 1_000_000,
        energyPerOutputToken: (MODEL_ENERGY[this.modelId]?.outputWhPerMillion ?? 0) / 1_000_000,
      },
    ];
  }

  estimateCost(): number {
    return 0;
  }
}

interface OllamaChatResponse {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaStreamChunk {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}
