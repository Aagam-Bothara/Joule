import type { Migration } from '../migrations.js';

/**
 * Migration 005 — Rate limiting persistence table.
 * Stores per-user, per-endpoint rate limit buckets.
 */
export const migration005: Migration = {
  version: 5,
  name: '005-rate-limits',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket_key TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        reset_at TEXT NOT NULL
      )
    `);
  },
};
