import type { Migration } from '../migrations.js';

/**
 * Migration 003 — Vector search tables.
 * The vec0 virtual table is only created if sqlite-vec is available.
 * Falls back to metadata-only table for TF-IDF fallback.
 */
export const migration003: Migration = {
  version: 3,
  name: '003-vector-tables',
  up(db) {
    // Metadata table for vector entries (always created)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_entries (
        id TEXT PRIMARY KEY,
        content_hash TEXT,
        dims INTEGER NOT NULL DEFAULT 384,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Try to create vec0 virtual table (requires sqlite-vec extension)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vector_index USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[384]
        )
      `);
    } catch {
      // sqlite-vec not available — vector search will use TF-IDF fallback
    }
  },
};
