/**
 * OllamaEmbeddingProvider — local embedding generation via Ollama.
 *
 * Uses the /api/embed endpoint (Ollama 0.4+) with models like
 * nomic-embed-text, all-minilm, mxbai-embed-large, etc.
 *
 * Runs entirely offline — no API keys, no cloud calls, no cost.
 */

import { EmbeddingProvider, type EmbeddingResult } from '../embedding-provider.js';

/** Well-known embedding models and their output dimensions. */
const MODEL_DIMS: Record<string, number> = {
  'nomic-embed-text': 768,
  'all-minilm': 384,
  'mxbai-embed-large': 1024,
  'snowflake-arctic-embed': 1024,
  'bge-m3': 1024,
  'bge-large': 1024,
};

export class OllamaEmbeddingProvider extends EmbeddingProvider {
  readonly name = 'ollama';

  private baseUrl: string;
  private model: string;
  private dims: number;
  private batchSize: number;

  constructor(config?: {
    baseUrl?: string;
    model?: string;
    dimensions?: number;
    batchSize?: number;
  }) {
    super();
    this.baseUrl = config?.baseUrl ?? 'http://localhost:11434';
    this.model = config?.model ?? 'nomic-embed-text';
    this.dims = config?.dimensions ?? MODEL_DIMS[this.model] ?? 768;
    this.batchSize = config?.batchSize ?? 32;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;

      const data = (await res.json()) as { models?: Array<{ name: string }> };
      // Check if the embedding model is pulled
      return (
        data.models?.some(
          (m) =>
            m.name === this.model ||
            m.name.startsWith(`${this.model}:`),
        ) ?? false
      );
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embed error (${res.status}): ${body}`);
    }

    const data = (await res.json()) as OllamaEmbedResponse;

    return {
      embedding: data.embeddings[0],
      model: data.model ?? this.model,
      promptTokens: data.prompt_eval_count ?? 0,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const results: EmbeddingResult[] = [];

    // Process in batches to avoid overwhelming the server
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: batch }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama embed batch error (${res.status}): ${body}`);
      }

      const data = (await res.json()) as OllamaEmbedResponse;

      for (let j = 0; j < data.embeddings.length; j++) {
        results.push({
          embedding: data.embeddings[j],
          model: data.model ?? this.model,
          promptTokens: data.prompt_eval_count ?? 0,
        });
      }
    }

    return results;
  }

  getDimensions(): number {
    return this.dims;
  }
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings: number[][];
  prompt_eval_count?: number;
}
