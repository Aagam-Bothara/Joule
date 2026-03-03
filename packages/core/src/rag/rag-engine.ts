/**
 * RagEngine — Retrieval-Augmented Generation engine.
 *
 * Indexes documents (via DocumentProcessor), stores chunks in a vector
 * index or TF-IDF fallback, and retrieves relevant context for agent prompts.
 *
 * When an EmbeddingProvider is available, uses real model-based embeddings
 * (e.g. nomic-embed-text via Ollama) for higher quality semantic search.
 * Falls back to TF-IDF when no embedding provider is configured.
 */

import { generateId } from '@joule/shared';
import { DocumentProcessor, type DocumentChunk } from './document-processor.js';
import type { SemanticIndex } from '../memory/semantic-index.js';
import { hashEmbed } from '@joule/store';

export interface RagSearchResult {
  chunk: DocumentChunk;
  score: number;
}

export interface RagStats {
  documents: number;
  chunks: number;
  embeddingProvider?: string;
  usingRealEmbeddings: boolean;
}

/** Minimal interface for embedding providers (avoids circular dep on @joule/models). */
export interface RagEmbeddingProvider {
  embed(text: string): Promise<{ embedding: number[]; model: string; promptTokens: number }>;
  embedBatch(texts: string[]): Promise<Array<{ embedding: number[]; model: string; promptTokens: number }>>;
  getDimensions(): number;
  readonly name: string;
}

/** Minimal interface for VectorIndex (avoids hard dep on @joule/store class). */
interface VectorIndexLike {
  isAvailable(): boolean;
  insert(id: string, vector: number[]): void;
  search(queryVector: number[], limit?: number): Array<{ id: string; distance: number }>;
  getDims(): number;
}

export class RagEngine {
  private chunks = new Map<string, DocumentChunk>();
  private documentIds = new Set<string>();
  private processor: DocumentProcessor;
  private semanticIndex: SemanticIndex;
  private vectorIndex?: VectorIndexLike;
  private embeddingProvider?: RagEmbeddingProvider;

  constructor(
    semanticIndex: SemanticIndex,
    processor?: DocumentProcessor,
    vectorIndex?: VectorIndexLike,
    embeddingProvider?: RagEmbeddingProvider,
  ) {
    this.semanticIndex = semanticIndex;
    this.processor = processor ?? new DocumentProcessor();
    this.vectorIndex = vectorIndex;
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Index a file from disk. Returns the number of chunks created.
   */
  async indexDocument(filePath: string): Promise<number> {
    const chunks = this.processor.ingest(filePath);
    await this.addChunks(chunks);
    return chunks.length;
  }

  /**
   * Index raw text. Returns the number of chunks created.
   */
  async indexText(text: string, source: string): Promise<number> {
    const chunks = this.processor.ingestText(text, source);
    await this.addChunks(chunks);
    return chunks.length;
  }

  /**
   * Search indexed chunks for the most relevant results.
   * Uses real embeddings + vector search when available, TF-IDF otherwise.
   */
  async search(query: string, limit = 5): Promise<RagSearchResult[]> {
    // Try vector search with real embeddings first
    if (this.embeddingProvider && this.vectorIndex?.isAvailable()) {
      try {
        const queryResult = await this.embeddingProvider.embed(query);
        const vectorResults = this.vectorIndex.search(queryResult.embedding, limit);

        if (vectorResults.length > 0) {
          return vectorResults
            .map((r) => {
              const chunk = this.chunks.get(r.id);
              if (!chunk) return null;
              // Convert distance to similarity score (0-1)
              const score = 1 / (1 + r.distance);
              return { chunk, score };
            })
            .filter((r): r is RagSearchResult => r !== null);
        }
      } catch {
        // Fall through to TF-IDF
      }
    }

    // Fallback: TF-IDF semantic search
    const results = this.semanticIndex.search(query, limit);
    return results
      .map((r) => {
        const chunk = this.chunks.get(r.id);
        if (!chunk) return null;
        return { chunk, score: r.score };
      })
      .filter((r): r is RagSearchResult => r !== null);
  }

  /**
   * Build a context prompt from search results, suitable for injection
   * into an agent's system prompt or user message.
   */
  buildContextPrompt(results: RagSearchResult[], maxTokens = 4000): string {
    if (results.length === 0) return '';

    const lines: string[] = ['## Relevant Context (from indexed documents)\n'];
    let currentLength = lines[0].length;
    const approxCharsPerToken = 4;
    const maxChars = maxTokens * approxCharsPerToken;

    for (const r of results) {
      const entry = `### [${r.chunk.metadata.source}] (relevance: ${(r.score * 100).toFixed(0)}%)\n${r.chunk.content}\n`;

      if (currentLength + entry.length > maxChars) break;

      lines.push(entry);
      currentLength += entry.length;
    }

    return lines.join('\n');
  }

  /** Get statistics about indexed documents and chunks. */
  getStats(): RagStats {
    return {
      documents: this.documentIds.size,
      chunks: this.chunks.size,
      embeddingProvider: this.embeddingProvider?.name,
      usingRealEmbeddings: !!this.embeddingProvider,
    };
  }

  /** Remove all indexed data. */
  clear(): void {
    this.chunks.clear();
    this.documentIds.clear();
  }

  /**
   * Add chunks to all indexes (in-memory, semantic, and optionally vector).
   * Uses batch embedding for efficiency when an embedding provider is available.
   */
  private async addChunks(chunks: DocumentChunk[]): Promise<void> {
    // Add to in-memory store and TF-IDF index (always)
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
      this.documentIds.add(chunk.documentId);
      this.semanticIndex.add(chunk.id, chunk.content);
    }

    // Batch embed and store in vector index if provider available
    if (this.embeddingProvider && this.vectorIndex) {
      await this.embedAndStoreChunks(chunks);
    }
  }

  /**
   * Batch-embed chunks and store in the vector index.
   * Falls back to hash-based embeddings on failure.
   */
  private async embedAndStoreChunks(chunks: DocumentChunk[]): Promise<void> {
    const batchSize = 32;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      try {
        const results = await this.embeddingProvider!.embedBatch(
          batch.map((c) => c.content),
        );

        for (let j = 0; j < batch.length; j++) {
          this.vectorIndex!.insert(batch[j].id, results[j].embedding);
        }
      } catch {
        // Fall back to hash-based embeddings for this batch
        for (const chunk of batch) {
          const vec = hashEmbed(chunk.content, this.vectorIndex!.getDims());
          this.vectorIndex!.insert(chunk.id, vec);
        }
      }
    }
  }
}
