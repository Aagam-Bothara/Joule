import type { Migration } from '../migrations.js';

export const migration002: Migration = {
  version: 2,
  name: 'fts5-indexes',
  up(db) {
    // ── FTS5 for Semantic Memory ──────────────────────────────────
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_semantic_fts USING fts5(
        id UNINDEXED, key, value, category, tags,
        content='memory_semantic', content_rowid='rowid'
      )
    `);

    // Keep FTS in sync via triggers
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_semantic_ai AFTER INSERT ON memory_semantic BEGIN
        INSERT INTO memory_semantic_fts(rowid, id, key, value, category, tags)
        VALUES (new.rowid, new.id, new.key, new.value, new.category, COALESCE(new.tags, ''));
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_semantic_ad AFTER DELETE ON memory_semantic BEGIN
        INSERT INTO memory_semantic_fts(memory_semantic_fts, rowid, id, key, value, category, tags)
        VALUES ('delete', old.rowid, old.id, old.key, old.value, old.category, COALESCE(old.tags, ''));
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_semantic_au AFTER UPDATE ON memory_semantic BEGIN
        INSERT INTO memory_semantic_fts(memory_semantic_fts, rowid, id, key, value, category, tags)
        VALUES ('delete', old.rowid, old.id, old.key, old.value, old.category, COALESCE(old.tags, ''));
        INSERT INTO memory_semantic_fts(rowid, id, key, value, category, tags)
        VALUES (new.rowid, new.id, new.key, new.value, new.category, COALESCE(new.tags, ''));
      END
    `);

    // ── FTS5 for Episodic Memory ──────────────────────────────────
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_episodic_fts USING fts5(
        id UNINDEXED, summary, context, lessons_learned, tags,
        content='memory_episodic', content_rowid='rowid'
      )
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_episodic_ai AFTER INSERT ON memory_episodic BEGIN
        INSERT INTO memory_episodic_fts(rowid, id, summary, context, lessons_learned, tags)
        VALUES (new.rowid, new.id, new.summary, COALESCE(new.context, ''), COALESCE(new.lessons_learned, ''), COALESCE(new.tags, ''));
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_episodic_ad AFTER DELETE ON memory_episodic BEGIN
        INSERT INTO memory_episodic_fts(memory_episodic_fts, rowid, id, summary, context, lessons_learned, tags)
        VALUES ('delete', old.rowid, old.id, old.summary, COALESCE(old.context, ''), COALESCE(old.lessons_learned, ''), COALESCE(old.tags, ''));
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memory_episodic_au AFTER UPDATE ON memory_episodic BEGIN
        INSERT INTO memory_episodic_fts(memory_episodic_fts, rowid, id, summary, context, lessons_learned, tags)
        VALUES ('delete', old.rowid, old.id, old.summary, COALESCE(old.context, ''), COALESCE(old.lessons_learned, ''), COALESCE(old.tags, ''));
        INSERT INTO memory_episodic_fts(rowid, id, summary, context, lessons_learned, tags)
        VALUES (new.rowid, new.id, new.summary, COALESCE(new.context, ''), COALESCE(new.lessons_learned, ''), COALESCE(new.tags, ''));
      END
    `);

    // ── Populate FTS from existing data ──────────────────────────
    db.exec(`
      INSERT INTO memory_semantic_fts(rowid, id, key, value, category, tags)
      SELECT rowid, id, key, value, category, COALESCE(tags, '') FROM memory_semantic
    `);
    db.exec(`
      INSERT INTO memory_episodic_fts(rowid, id, summary, context, lessons_learned, tags)
      SELECT rowid, id, summary, COALESCE(context, ''), COALESCE(lessons_learned, ''), COALESCE(tags, '') FROM memory_episodic
    `);
  },
};
