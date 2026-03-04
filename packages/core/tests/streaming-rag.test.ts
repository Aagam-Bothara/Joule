import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamingRag, type StreamingRagEvent } from '../src/rag/streaming-rag.js';

// Mock fs module
vi.mock('node:fs', () => ({
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ isFile: () => true }),
  readdir: vi.fn().mockResolvedValue([]),
}));

function createMockEngine() {
  return {
    indexDocument: vi.fn(async () => 5),
    indexText: vi.fn(async () => 3),
    search: vi.fn(async () => []),
    clear: vi.fn(),
    getStats: vi.fn(() => ({ documents: 0, chunks: 0, usingRealEmbeddings: false })),
  };
}

describe('StreamingRag', () => {
  let engine: ReturnType<typeof createMockEngine>;
  let events: StreamingRagEvent[];
  let streaming: StreamingRag;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = createMockEngine();
    events = [];
    streaming = new StreamingRag(engine as any, {
      watchPaths: ['/tmp/docs'],
      debounceMs: 10,
      initialIndex: false,
      onEvent: (e) => events.push(e),
    });
  });

  afterEach(() => {
    streaming.stop();
  });

  describe('constructor', () => {
    it('should create with default options', () => {
      const s = new StreamingRag(engine as any, {
        watchPaths: ['/tmp/test'],
      });
      const stats = s.getStats();
      expect(stats.watching).toBe(false);
      expect(stats.watchedPaths).toEqual(['/tmp/test']);
    });
  });

  describe('start', () => {
    it('should start watching without initial index', async () => {
      await streaming.start();

      const stats = streaming.getStats();
      expect(stats.watching).toBe(true);
      expect(events.some(e => e.type === 'watching')).toBe(true);
    });

    it('should not start twice', async () => {
      await streaming.start();
      await streaming.start();

      // Only one 'watching' event
      const watchEvents = events.filter(e => e.type === 'watching');
      expect(watchEvents).toHaveLength(1);
    });
  });

  describe('stop', () => {
    it('should stop watching', async () => {
      await streaming.start();
      streaming.stop();

      const stats = streaming.getStats();
      expect(stats.watching).toBe(false);
      expect(events.some(e => e.type === 'stopped')).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return initial stats', () => {
      const stats = streaming.getStats();

      expect(stats.watching).toBe(false);
      expect(stats.indexedFiles).toBe(0);
      expect(stats.totalChunks).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe('reindexFile', () => {
    it('should re-index a file and track it in stats', async () => {
      const chunks = await streaming.reindexFile('/tmp/docs/test.md');

      expect(chunks).toBe(5);
      expect(engine.indexDocument).toHaveBeenCalledWith('/tmp/docs/test.md');
      expect(events.some(e => e.type === 'indexed')).toBe(true);

      // Stats should reflect the indexed file
      const stats = streaming.getStats();
      expect(stats.indexedFiles).toBe(1);
      expect(stats.totalChunks).toBe(5);
      expect(stats.lastIndexedAt).toBeDefined();
    });

    it('should handle index errors gracefully', async () => {
      engine.indexDocument.mockRejectedValueOnce(new Error('Read error'));

      const chunks = await streaming.reindexFile('/tmp/docs/bad.txt');

      expect(chunks).toBe(0);
      expect(events.some(e => e.type === 'error')).toBe(true);
    });
  });
});
