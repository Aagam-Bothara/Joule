/**
 * DocumentProcessor — RAG document ingestion and chunking.
 *
 * Ingests text files (txt, md, json, csv) and splits them into
 * searchable chunks using configurable strategies.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { generateId } from '@joule/shared';

export type ChunkStrategy = 'fixed' | 'sentence' | 'paragraph';

export interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  index: number;
  metadata: {
    source: string;
    mimeType: string;
    startOffset: number;
    endOffset: number;
  };
}

export interface ProcessorOptions {
  chunkStrategy: ChunkStrategy;
  /** Target chunk size in characters (for 'fixed' strategy). */
  chunkSize: number;
  /** Overlap between consecutive chunks in characters. */
  chunkOverlap: number;
  /** Maximum number of chunks to produce per document. */
  maxChunks?: number;
}

const DEFAULT_OPTIONS: ProcessorOptions = {
  chunkStrategy: 'paragraph',
  chunkSize: 1000,
  chunkOverlap: 200,
  maxChunks: 500,
};

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/xml',
  '.html': 'text/html',
  '.ts': 'text/typescript',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
};

export class DocumentProcessor {
  private options: ProcessorOptions;

  constructor(options?: Partial<ProcessorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Ingest a file from disk, parse, and chunk it. */
  ingest(filePath: string): DocumentChunk[] {
    const ext = extname(filePath).toLowerCase();
    const mimeType = MIME_MAP[ext] ?? 'text/plain';
    const raw = readFileSync(filePath, 'utf-8');

    let text: string;
    switch (ext) {
      case '.json':
        text = this.parseJson(raw);
        break;
      case '.csv':
        text = this.parseCsv(raw);
        break;
      default:
        text = raw;
    }

    return this.chunk(text, basename(filePath), mimeType);
  }

  /** Ingest raw text and chunk it. */
  ingestText(text: string, source: string, mimeType = 'text/plain'): DocumentChunk[] {
    return this.chunk(text, source, mimeType);
  }

  /** Split text into chunks using the configured strategy. */
  chunk(text: string, source: string, mimeType = 'text/plain', options?: Partial<ProcessorOptions>): DocumentChunk[] {
    const opts = { ...this.options, ...options };
    const documentId = generateId('doc');

    let rawChunks: Array<{ content: string; startOffset: number; endOffset: number }>;

    switch (opts.chunkStrategy) {
      case 'fixed':
        rawChunks = this.chunkFixed(text, opts.chunkSize, opts.chunkOverlap);
        break;
      case 'sentence':
        rawChunks = this.chunkSentence(text, opts.chunkSize, opts.chunkOverlap);
        break;
      case 'paragraph':
        rawChunks = this.chunkParagraph(text, opts.chunkSize);
        break;
      default:
        rawChunks = this.chunkParagraph(text, opts.chunkSize);
    }

    const maxChunks = opts.maxChunks ?? 500;
    const chunks = rawChunks.slice(0, maxChunks);

    return chunks.map((c, i) => ({
      id: generateId('chunk'),
      documentId,
      content: c.content,
      index: i,
      metadata: {
        source,
        mimeType,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
      },
    }));
  }

  // ── Chunking strategies ──────────────────────────────────────

  private chunkFixed(text: string, size: number, overlap: number) {
    const chunks: Array<{ content: string; startOffset: number; endOffset: number }> = [];
    let offset = 0;

    while (offset < text.length) {
      const end = Math.min(offset + size, text.length);
      chunks.push({
        content: text.slice(offset, end),
        startOffset: offset,
        endOffset: end,
      });
      offset += size - overlap;
      if (offset >= text.length) break;
    }

    return chunks;
  }

  private chunkSentence(text: string, targetSize: number, overlap: number) {
    // Split at sentence boundaries
    const sentences = text.split(/(?<=[.!?\n])\s+/);
    const chunks: Array<{ content: string; startOffset: number; endOffset: number }> = [];

    let current = '';
    let startOffset = 0;
    let currentOffset = 0;

    for (const sentence of sentences) {
      if (current.length + sentence.length > targetSize && current.length > 0) {
        chunks.push({
          content: current.trim(),
          startOffset,
          endOffset: currentOffset,
        });
        // Apply overlap: keep last portion of current chunk
        const overlapText = current.slice(-overlap);
        current = overlapText + sentence;
        startOffset = currentOffset - overlapText.length;
      } else {
        if (current.length === 0) startOffset = currentOffset;
        current += (current.length > 0 ? ' ' : '') + sentence;
      }
      currentOffset += sentence.length + 1;
    }

    if (current.trim().length > 0) {
      chunks.push({
        content: current.trim(),
        startOffset,
        endOffset: currentOffset,
      });
    }

    return chunks;
  }

  private chunkParagraph(text: string, targetSize: number) {
    // Split on double newlines (paragraphs)
    const paragraphs = text.split(/\n\s*\n/);
    const chunks: Array<{ content: string; startOffset: number; endOffset: number }> = [];

    let current = '';
    let startOffset = 0;
    let currentOffset = 0;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length === 0) {
        currentOffset += para.length + 2;
        continue;
      }

      if (current.length + trimmed.length > targetSize && current.length > 0) {
        chunks.push({
          content: current.trim(),
          startOffset,
          endOffset: currentOffset,
        });
        current = trimmed;
        startOffset = currentOffset;
      } else {
        if (current.length === 0) startOffset = currentOffset;
        current += (current.length > 0 ? '\n\n' : '') + trimmed;
      }
      currentOffset += para.length + 2;
    }

    if (current.trim().length > 0) {
      chunks.push({
        content: current.trim(),
        startOffset,
        endOffset: currentOffset,
      });
    }

    return chunks;
  }

  // ── Format parsers ───────────────────────────────────────────

  private parseJson(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  }

  private parseCsv(raw: string): string {
    // Convert CSV to readable text (header: value pairs)
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 2) return raw;

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      return headers.map((h, i) => `${h}: ${values[i] ?? ''}`).join(', ');
    });

    return rows.join('\n');
  }
}
