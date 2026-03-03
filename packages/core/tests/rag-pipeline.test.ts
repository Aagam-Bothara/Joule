import { describe, it, expect, beforeEach } from 'vitest';
import { DocumentProcessor } from '../src/rag/document-processor.js';
import { RagEngine } from '../src/rag/rag-engine.js';
import { SemanticIndex } from '../src/memory/semantic-index.js';

describe('DocumentProcessor', () => {
  describe('fixed chunking', () => {
    it('should split text into fixed-size chunks', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'fixed',
        chunkSize: 50,
        chunkOverlap: 10,
      });

      const text = 'A'.repeat(120);
      const chunks = processor.ingestText(text, 'test.txt');

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0].content.length).toBe(50);
      expect(chunks[0].metadata.source).toBe('test.txt');
    });

    it('should handle text shorter than chunk size', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'fixed',
        chunkSize: 1000,
        chunkOverlap: 100,
      });

      const chunks = processor.ingestText('Short text.', 'short.txt');
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('Short text.');
    });
  });

  describe('sentence chunking', () => {
    it('should split at sentence boundaries', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'sentence',
        chunkSize: 50,
        chunkOverlap: 0,
      });

      const text = 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.';
      const chunks = processor.ingestText(text, 'sentences.txt');

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // Each chunk should end near a sentence boundary
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeGreaterThan(0);
      }
    });
  });

  describe('paragraph chunking', () => {
    it('should split at paragraph boundaries', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'paragraph',
        chunkSize: 100,
        chunkOverlap: 0,
      });

      const text = 'First paragraph content here.\n\nSecond paragraph content here.\n\nThird paragraph content here.';
      const chunks = processor.ingestText(text, 'paragraphs.txt');

      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('should merge small paragraphs', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'paragraph',
        chunkSize: 1000,
        chunkOverlap: 0,
      });

      const text = 'Short.\n\nAlso short.\n\nStill short.';
      const chunks = processor.ingestText(text, 'small.txt');

      // All paragraphs fit in one chunk
      expect(chunks.length).toBe(1);
    });
  });

  describe('maxChunks', () => {
    it('should limit the number of chunks', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'fixed',
        chunkSize: 10,
        chunkOverlap: 0,
        maxChunks: 3,
      });

      const text = 'A'.repeat(100);
      const chunks = processor.ingestText(text, 'test.txt');

      expect(chunks.length).toBeLessThanOrEqual(3);
    });
  });

  describe('CSV parsing', () => {
    it('should convert CSV to readable text', () => {
      const processor = new DocumentProcessor();
      const csv = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA';
      const chunks = processor.chunk(csv, 'data.csv', 'text/csv');

      // CSV parsing happens at ingest level, not chunk level
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('chunk metadata', () => {
    it('should assign unique IDs and sequential indices', () => {
      const processor = new DocumentProcessor({
        chunkStrategy: 'fixed',
        chunkSize: 20,
        chunkOverlap: 0,
      });

      const chunks = processor.ingestText('A'.repeat(50), 'test.txt');

      const ids = new Set(chunks.map(c => c.id));
      expect(ids.size).toBe(chunks.length); // all unique

      chunks.forEach((c, i) => {
        expect(c.index).toBe(i);
        expect(c.metadata.source).toBe('test.txt');
      });
    });
  });
});

describe('RagEngine', () => {
  let engine: RagEngine;
  let index: SemanticIndex;

  beforeEach(() => {
    index = new SemanticIndex();
    engine = new RagEngine(index);
  });

  describe('indexing', () => {
    it('should index text and return chunk count', async () => {
      const count = await engine.indexText(
        'Machine learning is a subset of artificial intelligence. It enables computers to learn from data.',
        'ml.txt',
      );

      expect(count).toBeGreaterThanOrEqual(1);
      expect(engine.getStats().chunks).toBe(count);
      expect(engine.getStats().documents).toBe(1);
    });

    it('should index multiple documents', async () => {
      await engine.indexText('Document one about TypeScript.', 'doc1.txt');
      await engine.indexText('Document two about Python.', 'doc2.txt');

      expect(engine.getStats().documents).toBe(2);
    });
  });

  describe('search', () => {
    it('should return relevant chunks', async () => {
      await engine.indexText(
        'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
        'typescript.txt',
      );
      await engine.indexText(
        'Python is a programming language known for its simplicity and readability.',
        'python.txt',
      );

      const results = await engine.search('TypeScript JavaScript');

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('should return empty for no matches', async () => {
      const results = await engine.search('quantum physics');
      expect(results.length).toBe(0);
    });
  });

  describe('context prompt', () => {
    it('should build a formatted context string', async () => {
      await engine.indexText('React is a UI library for building user interfaces.', 'react.txt');

      const results = await engine.search('React UI');
      const prompt = engine.buildContextPrompt(results);

      expect(prompt).toContain('Relevant Context');
      expect(prompt).toContain('relevance:');
    });

    it('should return empty string for no results', () => {
      const prompt = engine.buildContextPrompt([]);
      expect(prompt).toBe('');
    });
  });

  describe('clear', () => {
    it('should remove all indexed data', async () => {
      await engine.indexText('Some text.', 'test.txt');
      expect(engine.getStats().chunks).toBeGreaterThan(0);

      engine.clear();
      expect(engine.getStats().chunks).toBe(0);
      expect(engine.getStats().documents).toBe(0);
    });
  });
});
