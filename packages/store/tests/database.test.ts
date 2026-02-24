import { describe, it, expect, afterEach } from 'vitest';
import { createTestDatabase, _resetSingleton, closeDatabase } from '../src/database.js';

afterEach(() => {
  try { closeDatabase(); } catch { /* ignore */ }
  _resetSingleton();
});

describe('createTestDatabase', () => {
  it('creates an in-memory database', () => {
    const db = createTestDatabase();
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
    db.close();
  });

  it('applies WAL mode', () => {
    const db = createTestDatabase();
    const mode = db.pragma('journal_mode', { simple: true });
    // In-memory databases may report 'memory' or 'wal'
    expect(['wal', 'memory']).toContain(mode);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = createTestDatabase();
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    db.close();
  });

  it('creates isolated databases per call', () => {
    const db1 = createTestDatabase();
    const db2 = createTestDatabase();
    db1.exec('CREATE TABLE test1 (id INTEGER)');

    // db2 should not have test1
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test1'").all();
    expect(tables).toHaveLength(0);

    db1.close();
    db2.close();
  });
});
