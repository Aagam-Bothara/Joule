// ── Database & Migrations ────────────────────────────────────────
export { getDatabase, closeDatabase, createTestDatabase, _resetSingleton } from './database.js';
export type { DatabaseOptions } from './database.js';
export { runMigrations, getCurrentVersion } from './migrations.js';
export type { Migration } from './migrations.js';
export { allMigrations } from './migrations/index.js';

// ── Repositories ─────────────────────────────────────────────────
export { TaskRepository } from './repositories/task.repository.js';
export type { TaskRow, TaskListOptions } from './repositories/task.repository.js';

export { SessionRepository } from './repositories/session.repository.js';
export type {
  SessionRow, SessionMessageRow, SessionData, SessionListEntry,
} from './repositories/session.repository.js';

export { TraceRepository } from './repositories/trace.repository.js';
export type { TraceData, SpanData, EventData } from './repositories/trace.repository.js';

export { MemoryRepository } from './repositories/memory.repository.js';
export type {
  SemanticData, EpisodicData, ProceduralData, PreferenceData,
  LinkData, FailureData, MemoryCounts, BulkMemoryData,
  SemanticSearchOptions, EpisodicSearchOptions,
} from './repositories/memory.repository.js';

export { ScheduleRepository } from './repositories/schedule.repository.js';
export type {
  ScheduleData, ScheduleLogData, ScheduleLogOptions,
} from './repositories/schedule.repository.js';

export { UserRepository } from './repositories/user.repository.js';
export type { UserData, ApiKeyData } from './repositories/user.repository.js';

// ── Store ────────────────────────────────────────────────────────

import type Database from 'better-sqlite3';
import { getDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { allMigrations } from './migrations/index.js';
import { TaskRepository } from './repositories/task.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { TraceRepository } from './repositories/trace.repository.js';
import { MemoryRepository } from './repositories/memory.repository.js';
import { ScheduleRepository } from './repositories/schedule.repository.js';
import { UserRepository } from './repositories/user.repository.js';

export interface JouleStore {
  db: Database.Database;
  tasks: TaskRepository;
  sessions: SessionRepository;
  traces: TraceRepository;
  memory: MemoryRepository;
  schedules: ScheduleRepository;
  users: UserRepository;
}

/**
 * Initialize the complete Joule store: open/create database, run migrations,
 * and return all repository instances ready to use.
 *
 * @param dbPath - Optional path to the SQLite database file. Defaults to `.joule/joule.db`.
 */
export function initializeStore(dbPath?: string): JouleStore {
  const db = getDatabase(dbPath ? { dbPath } : undefined);
  runMigrations(db, allMigrations);

  return {
    db,
    tasks: new TaskRepository(db),
    sessions: new SessionRepository(db),
    traces: new TraceRepository(db),
    memory: new MemoryRepository(db),
    schedules: new ScheduleRepository(db),
    users: new UserRepository(db),
  };
}
