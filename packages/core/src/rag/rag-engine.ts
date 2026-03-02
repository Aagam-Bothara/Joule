/**
 * RagEngine — Retrieval-Augmented Generation engine.
 *
 * Indexes documents (via DocumentProcessor), stores chunks in a vector
 * index or TF-IDF fallback, and retrieves relevant context for agent prompts.
 */

import { generateId } from '@joule/shared';
import { DocumentProcessor, type DocumentChunk } from './document-processor.js';
import type { SemanticIndex } from '../memory/semantic-index.js';

export interface RagSearchResult {
  chunk: DocumentChunk;
  score: number;
}

export interface RagStats {
  documents: number;
  chunks: number;
}

export class RagEngine {
  private chunks = new Map<string, DocumentChunk>();
  private documentIds = new Set<string>();
  private processor: DocumentProcessor;
  private semanticIndex: SemanticIndex;
  private vectorIndex?: any; // VectorIndex from @joule/store (optional)

  constructor(
    semanticIndex: SemanticIndex,
    processor?: DocumentProcessor,
    vectorIndex?: any,
  ) {
    this.semanticIndex = semanticIndex;
    this.processor = processor ?? new DocumentProcessor();
    this.vectorIndex = vectorIndex;
  }

  /**
   * Index a file from disk. Returns the number of chunks created.
   */
  async indexDocument(filePath: string): Promise<number> {
    const chunks = this.processor.ingest(filePath);
    for (const chunk of chunks) {
      this.addChunk(chunk);
    }
    return chunks.length;
  }

  /**
   * Index raw text. Returns the number of chunks created.
   */
  async indexText(text: string, source: string): Promise<number> {
    const chunks = this.processor.ingestText(text, source);
    for (const chunk of chunks) {
      this.addChunk(chunk);
    }
    return chunks.length;
  }

  /**
   * Search indexed chunks for the most relevant results.
   */
  search(query: string, limit = 5): RagSearchResult[] {
    // Use vector index if available, otherwise TF-IDF
    const results = this.semanticIndex.search(query, limit);

    return results
      .map(r => {
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
    };
  }

  /** Remove all indexed data. */
  clear(): void {
    this.chunks.clear();
    this.documentIds.clear();
  }

  private addChunk(chunk: DocumentChunk): void {
    this.chunks.set(chunk.id, chunk);
    this.documentIds.add(chunk.documentId);

    // Add to semantic index for TF-IDF search
    this.semanticIndex.add(chunk.id, chunk.content);
  }
}
