export enum ModelTier {
  SLM = 'slm',
  LLM = 'llm',
}

export type ModelProviderName = 'ollama' | 'anthropic' | 'openai' | 'google';

export interface ChatMessageImage {
  /** base64-encoded image data */
  data: string;
  /** MIME type of the image */
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Optional images for multimodal messages (vision) */
  images?: ChatMessageImage[];
}

export interface ModelRequest {
  model: string;
  provider: ModelProviderName;
  tier: ModelTier;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  model: string;
  provider: ModelProviderName;
  tier: ModelTier;
  content: string;
  tokenUsage: TokenUsage;
  latencyMs: number;
  costUsd: number;
  confidence?: number;
  finishReason: 'stop' | 'length' | 'error';
  energyWh?: number;
  carbonGrams?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  tier: ModelTier;
  contextWindow: number;
  costPerInputToken: number;
  costPerOutputToken: number;
  energyPerInputToken?: number;
  energyPerOutputToken?: number;
}
