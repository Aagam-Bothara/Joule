import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../src/database.js';
import { runMigrations, getCurrentVersion } from '../src/migrations.js';
import { allMigrations } from '../src/migrations/index.js';

describe('runMigrations', () => {
  it('creates _migrations table', () => {
    const db = createTestDatabase();
    runMigrations(db, []);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it('runs initial schema migration', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('session_messages');
    expect(tableNames).toContain('traces');
    expect(tableNames).toContain('trace_spans');
    expect(tableNames).toContain('trace_events');
    expect(tableNames).toContain('memory_semantic');
    expect(tableNames).toContain('memory_episodic');
    expect(tableNames).toContain('memory_procedural');
    expect(tableNames).toContain('memory_preferences');
    expect(tableNames).toContain('memory_links');
    expect(tableNames).toContain('memory_failures');
    expect(tableNames).toContain('schedules');
    expect(tableNames).toContain('schedule_logs');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('api_keys');
    db.close();
  });

  it('records migration version', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);

    const version = getCurrentVersion(db);
    expect(version).toBe(1);
    db.close();
  });

  it('is idempotent — running twice does not fail', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);
    runMigrations(db, allMigrations);

    const version = getCurrentVersion(db);
    expect(version).toBe(1);
    db.close();
  });

  it('getCurrentVersion returns 0 when no migrations table exists', () => {
    const db = createTestDatabase();
    const version = getCurrentVersion(db);
    expect(version).toBe(0);
    db.close();
  });
});
