import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

/**
 * Run all pending migrations in order.
 * Each migration runs in its own transaction for atomicity.
 * Creates the _migrations tracking table if it doesn't exist.
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const currentVersion = (
    db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM _migrations').get() as { v: number }
  ).v;

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  for (const migration of sorted) {
    if (migration.version <= currentVersion) continue;

    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name,
      );
    })();
  }
}

/**
 * Returns the highest applied migration version, or 0 if none.
 */
export function getCurrentVersion(db: Database.Database): number {
  try {
    return (
      db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM _migrations').get() as { v: number }
    ).v;
  } catch {
    return 0;
  }
}
