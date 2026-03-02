import type { Migration } from '../migrations.js';

/**
 * Migration 004 — LLM response cache table.
 * SHA-256 keyed cache with TTL expiration.
 */
export const migration004: Migration = {
  version: 4,
  name: '004-response-cache',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS response_cache (
        cache_key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_response_cache_expires
      ON response_cache(expires_at)
    `);
  },
};
