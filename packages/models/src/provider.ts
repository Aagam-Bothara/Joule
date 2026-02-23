import type {
  ModelRequest,
  ModelResponse,
  ModelProviderName,
  ModelTier,
  ModelInfo,
  TokenUsage,
} from '@joule/shared';

export interface StreamChunk {
  content: string;
  done: boolean;
  tokenUsage?: Partial<TokenUsage>;
  finishReason?: 'stop' | 'length' | 'error';
}

export abstract class ModelProvider {
  abstract readonly name: ModelProviderName;
  abstract readonly supportedTiers: ModelTier[];

  abstract isAvailable(): Promise<boolean>;
  abstract chat(request: ModelRequest): Promise<ModelResponse>;
  abstract chatStream(request: ModelRequest): AsyncGenerator<StreamChunk>;
  abstract listModels(): Promise<ModelInfo[]>;
  abstract estimateCost(promptTokens: number, model: string): number;
}
