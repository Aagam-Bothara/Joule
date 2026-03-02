/**
 * LLM Response Cache.
 *
 * SHA-256 hash-indexed cache stored in SQLite for persistence across restarts.
 * Supports TTL-based expiration, max entry limits, and hit/miss statistics.
 */

import { createHash } from 'node:crypto';
import type { ChatMessage } from '@joule/shared';

export interface ResponseCacheConfig {
  /** Enable/disable caching (default: false). */
  enabled: boolean;
  /** Time-to-live in ms (default: 3_600_000 = 1 hour). */
  ttlMs: number;
  /** Maximum cache entries before eviction (default: 10_000). */
  maxEntries: number;
  /** Skip caching for streaming requests (default: true). */
  skipStreaming: boolean;
}

export interface CachedResponse {
  content: string;
  model: string;
  provider: string;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  costUsd: number;
  latencyMs: number;
  cachedAt: string;
}

interface CacheRow {
  cache_key: string;
  response: string;
  model: string;
  created_at: string;
  expires_at: string;
}

export const DEFAULT_CACHE_CONFIG: ResponseCacheConfig = {
  enabled: false,
  ttlMs: 3_600_000,
  maxEntries: 10_000,
  skipStreaming: true,
};

export class ResponseCache {
  private hits = 0;
  private misses = 0;
  private db: any; // better-sqlite3 Database

  constructor(db: any, private config: ResponseCacheConfig = DEFAULT_CACHE_CONFIG) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS response_cache (
        cache_key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_response_cache_expires
      ON response_cache(expires_at)
    `);
  }

  /**
   * Compute a deterministic cache key from the request parameters.
   * Uses SHA-256 of normalized (model + system + messages + temperature + format).
   */
  computeKey(
    model: string,
    system: string | undefined,
    messages: ChatMessage[],
    temperature?: number,
    responseFormat?: string,
  ): string {
    const normalized = JSON.stringify({
      model,
      system: system ?? '',
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        // Exclude images from cache key (too large, and visual queries
        // with same text but different images should cache separately)
        hasImages: m.images ? m.images.length : 0,
      })),
      temperature: temperature ?? 0,
      responseFormat: responseFormat ?? 'text',
    });

    return createHash('sha256').update(normalized).digest('hex');
  }

  /** Look up a cached response. Returns null on miss or expiration. */
  get(key: string): CachedResponse | null {
    if (!this.config.enabled) {
      this.misses++;
      return null;
    }

    const row = this.db.prepare(
      'SELECT * FROM response_cache WHERE cache_key = ? AND expires_at > ?',
    ).get(key, new Date().toISOString()) as CacheRow | undefined;

    if (!row) {
      this.misses++;
      return null;
    }

    this.hits++;
    try {
      return JSON.parse(row.response) as CachedResponse;
    } catch {
      // Corrupted entry — remove it
      this.db.prepare('DELETE FROM response_cache WHERE cache_key = ?').run(key);
      this.misses++;
      return null;
    }
  }

  /** Store a response in the cache. */
  set(key: string, response: CachedResponse): void {
    if (!this.config.enabled) return;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.ttlMs);

    this.db.prepare(`
      INSERT OR REPLACE INTO response_cache (cache_key, response, model, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      key,
      JSON.stringify(response),
      response.model,
      now.toISOString(),
      expiresAt.toISOString(),
    );

    // Evict if over limit
    this.evict();
  }

  /** Remove expired entries and trim to maxEntries. Returns count removed. */
  evict(): number {
    const now = new Date().toISOString();

    // Remove expired
    const expired = this.db.prepare(
      'DELETE FROM response_cache WHERE expires_at <= ?',
    ).run(now);

    // Trim to max entries (keep newest)
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM response_cache').get() as { cnt: number };
    let trimmed = 0;

    if (count.cnt > this.config.maxEntries) {
      const excess = count.cnt - this.config.maxEntries;
      this.db.prepare(`
        DELETE FROM response_cache WHERE cache_key IN (
          SELECT cache_key FROM response_cache ORDER BY created_at ASC LIMIT ?
        )
      `).run(excess);
      trimmed = excess;
    }

    return (expired.changes ?? 0) + trimmed;
  }

  /** Get cache statistics. */
  getStats(): { hits: number; misses: number; hitRate: number; entries: number } {
    const total = this.hits + this.misses;
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM response_cache').get() as { cnt: number };

    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      entries: count.cnt,
    };
  }

  /** Clear all cached responses. */
  clear(): void {
    this.db.prepare('DELETE FROM response_cache').run();
    this.hits = 0;
    this.misses = 0;
  }
}
