/**
 * EmbeddingProvider — abstract base for text embedding providers.
 *
 * Implementations generate dense vector embeddings from text, used for
 * semantic search in RAG pipelines and memory systems.
 */

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  promptTokens: number;
}

export abstract class EmbeddingProvider {
  abstract readonly name: string;

  /** Check if the embedding provider is reachable and ready. */
  abstract isAvailable(): Promise<boolean>;

  /** Embed a single text string. */
  abstract embed(text: string): Promise<EmbeddingResult>;

  /** Embed multiple texts in a single request (more efficient). */
  abstract embedBatch(texts: string[]): Promise<EmbeddingResult[]>;

  /** Return the output dimensionality for this provider/model. */
  abstract getDimensions(): number;
}
