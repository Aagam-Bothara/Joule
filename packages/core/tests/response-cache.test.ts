import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDatabase } from '@joule/store';
import { ResponseCache } from '../src/response-cache.js';
import type { CachedResponse } from '../src/response-cache.js';

function makeResponse(content = 'Hello world'): CachedResponse {
  return {
    content,
    model: 'test-model',
    provider: 'test',
    tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    costUsd: 0.001,
    latencyMs: 200,
    cachedAt: new Date().toISOString(),
  };
}

describe('ResponseCache', () => {
  let db: any;
  let cache: ResponseCache;

  beforeEach(() => {
    db = createTestDatabase();
    cache = new ResponseCache(db, {
      enabled: true,
      ttlMs: 60_000, // 1 minute
      maxEntries: 100,
      skipStreaming: true,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('cache key computation', () => {
    it('should produce deterministic keys for same input', () => {
      const key1 = cache.computeKey('model-1', 'system', [{ role: 'user', content: 'hello' }], 0.5);
      const key2 = cache.computeKey('model-1', 'system', [{ role: 'user', content: 'hello' }], 0.5);
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different inputs', () => {
      const key1 = cache.computeKey('model-1', 'system', [{ role: 'user', content: 'hello' }]);
      const key2 = cache.computeKey('model-1', 'system', [{ role: 'user', content: 'world' }]);
      expect(key1).not.toBe(key2);
    });

    it('should produce different keys for different models', () => {
      const key1 = cache.computeKey('model-1', 'sys', [{ role: 'user', content: 'hi' }]);
      const key2 = cache.computeKey('model-2', 'sys', [{ role: 'user', content: 'hi' }]);
      expect(key1).not.toBe(key2);
    });
  });

  describe('get/set', () => {
    it('should miss on empty cache', () => {
      const result = cache.get('nonexistent');
      expect(result).toBeNull();
    });

    it('should hit after set', () => {
      const key = 'test-key';
      const response = makeResponse('cached result');

      cache.set(key, response);
      const result = cache.get(key);

      expect(result).not.toBeNull();
      expect(result!.content).toBe('cached result');
    });

    it('should track hit/miss stats', () => {
      const key = 'test-key';
      cache.set(key, makeResponse());

      cache.get('miss-1');
      cache.get('miss-2');
      cache.get(key); // hit

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(2);
      expect(stats.hitRate).toBeCloseTo(1 / 3);
    });
  });

  describe('TTL expiration', () => {
    it('should not return expired entries', () => {
      const shortCache = new ResponseCache(db, {
        enabled: true,
        ttlMs: 1, // 1ms TTL — will expire immediately
        maxEntries: 100,
        skipStreaming: true,
      });

      shortCache.set('test', makeResponse());

      // Wait for expiration
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin */ }

      const result = shortCache.get('test');
      expect(result).toBeNull();
    });
  });

  describe('eviction', () => {
    it('should evict oldest entries when maxEntries exceeded', () => {
      const smallCache = new ResponseCache(db, {
        enabled: true,
        ttlMs: 60_000,
        maxEntries: 3,
        skipStreaming: true,
      });

      smallCache.set('key-1', makeResponse('first'));
      smallCache.set('key-2', makeResponse('second'));
      smallCache.set('key-3', makeResponse('third'));
      smallCache.set('key-4', makeResponse('fourth')); // triggers eviction

      const stats = smallCache.getStats();
      expect(stats.entries).toBeLessThanOrEqual(3);
    });
  });

  describe('disabled mode', () => {
    it('should always miss when disabled', () => {
      const disabledCache = new ResponseCache(db, {
        enabled: false,
        ttlMs: 60_000,
        maxEntries: 100,
        skipStreaming: true,
      });

      disabledCache.set('test', makeResponse());
      const result = disabledCache.get('test');
      expect(result).toBeNull();
    });
  });

  describe('clear', () => {
    it('should remove all entries and reset stats', () => {
      cache.set('key-1', makeResponse());
      cache.set('key-2', makeResponse());
      cache.get('key-1');

      cache.clear();

      const stats = cache.getStats();
      expect(stats.entries).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });
});
