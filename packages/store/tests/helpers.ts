import { createTestDatabase } from '../src/database.js';
import { runMigrations } from '../src/migrations.js';
import { allMigrations } from '../src/migrations/index.js';
import type Database from 'better-sqlite3';

/** Create a fresh in-memory database with all migrations applied. */
export function freshDb(): Database.Database {
  const db = createTestDatabase();
  runMigrations(db, allMigrations);
  return db;
}
