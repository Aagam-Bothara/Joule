import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

const DEFAULT_DB_PATH = '.joule/joule.db';

let instance: Database.Database | null = null;

export interface DatabaseOptions {
  /** Path to the SQLite database file. Defaults to .joule/joule.db */
  dbPath?: string;
  /** Open in read-only mode */
  readonly?: boolean;
}

/**
 * Returns (or creates) the singleton database connection.
 * Configures WAL mode, foreign keys, and production pragmas on first call.
 */
export function getDatabase(options?: DatabaseOptions): Database.Database {
  if (instance) return instance;

  const dbPath = options?.dbPath ?? path.join(process.cwd(), DEFAULT_DB_PATH);

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, {
    readonly: options?.readonly ?? false,
  });

  applyPragmas(db);

  instance = db;
  return db;
}

/**
 * Close the singleton database connection and reset.
 */
export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Create an in-memory database with production pragmas.
 * Used for testing — each call returns a fresh isolated DB.
 */
export function createTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  applyPragmas(db);
  return db;
}

/**
 * Reset the singleton reference without closing.
 * For testing only — caller is responsible for closing the old connection.
 */
export function _resetSingleton(): void {
  instance = null;
}

function applyPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');       // 64 MB
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');       // 5 s
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');     // 256 MB
}
