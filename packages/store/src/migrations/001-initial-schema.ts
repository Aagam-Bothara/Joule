import type { Migration } from '../migrations.js';

export const migration001: Migration = {
  version: 1,
  name: 'initial-schema',
  up(db) {
    // ── Tasks ────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT PRIMARY KEY,
        description      TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        result           TEXT,
        step_results     TEXT,
        budget_allocated TEXT,
        budget_used      TEXT,
        error            TEXT,
        trace_id         TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at     TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)');

    // ── Sessions ─────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                  TEXT PRIMARY KEY,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        message_count       INTEGER NOT NULL DEFAULT 0,
        total_cost_usd      REAL NOT NULL DEFAULT 0,
        total_energy_wh     REAL NOT NULL DEFAULT 0,
        total_carbon_grams  REAL NOT NULL DEFAULT 0,
        total_tokens        INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessmsg_sid ON session_messages(session_id)');

    // ── Traces ───────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id         TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        started_at       TEXT NOT NULL,
        completed_at     TEXT,
        duration_ms      REAL,
        budget_allocated TEXT,
        budget_used      TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(task_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS trace_spans (
        id             TEXT PRIMARY KEY,
        trace_id       TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
        parent_span_id TEXT,
        name           TEXT NOT NULL,
        start_time     REAL NOT NULL,
        end_time       REAL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tspans_trace ON trace_spans(trace_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        id         TEXT PRIMARY KEY,
        trace_id   TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
        span_id    TEXT REFERENCES trace_spans(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        timestamp  REAL NOT NULL,
        wall_clock TEXT NOT NULL,
        duration   REAL,
        data       TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tevt_trace ON trace_events(trace_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tevt_type ON trace_events(type)');

    // ── Memory: Semantic (Layer 1) ───────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_semantic (
        id               TEXT PRIMARY KEY,
        key              TEXT NOT NULL,
        value            TEXT NOT NULL,
        category         TEXT NOT NULL,
        source           TEXT NOT NULL,
        confidence       REAL NOT NULL DEFAULT 0.5,
        scope            TEXT NOT NULL DEFAULT 'project',
        scope_id         TEXT,
        tags             TEXT,
        supersedes       TEXT,
        superseded_by    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count     INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_msem_key ON memory_semantic(key)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_msem_cat ON memory_semantic(category)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_msem_scope ON memory_semantic(scope, scope_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_msem_conf ON memory_semantic(confidence)');

    // ── Memory: Episodic (Layer 2) ───────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_episodic (
        id               TEXT PRIMARY KEY,
        task_id          TEXT NOT NULL,
        summary          TEXT NOT NULL,
        outcome          TEXT NOT NULL,
        tools_used       TEXT,
        steps_completed  INTEGER NOT NULL DEFAULT 0,
        total_steps      INTEGER NOT NULL DEFAULT 0,
        energy_used      REAL NOT NULL DEFAULT 0,
        carbon_used      REAL NOT NULL DEFAULT 0,
        cost_usd         REAL NOT NULL DEFAULT 0,
        duration_ms      REAL NOT NULL DEFAULT 0,
        scope            TEXT NOT NULL DEFAULT 'project',
        scope_id         TEXT,
        context          TEXT,
        lessons_learned  TEXT,
        tags             TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count     INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mepi_task ON memory_episodic(task_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mepi_out ON memory_episodic(outcome)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mepi_scope ON memory_episodic(scope, scope_id)');

    // ── Memory: Procedural (Layer 3) ─────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_procedural (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT NOT NULL,
        pattern          TEXT NOT NULL,
        confidence       REAL NOT NULL DEFAULT 0.5,
        success_rate     REAL NOT NULL DEFAULT 0,
        times_used       INTEGER NOT NULL DEFAULT 0,
        scope            TEXT NOT NULL DEFAULT 'project',
        scope_id         TEXT,
        tags             TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count     INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mproc_name ON memory_procedural(name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mproc_scope ON memory_procedural(scope, scope_id)');

    // ── Memory: Preferences (Layer 4) ────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_preferences (
        id               TEXT PRIMARY KEY,
        key              TEXT NOT NULL,
        value            TEXT NOT NULL,
        learned_from     TEXT NOT NULL,
        confidence       REAL NOT NULL DEFAULT 0.5,
        scope            TEXT NOT NULL DEFAULT 'user',
        scope_id         TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count     INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mpref_key ON memory_preferences(key)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mpref_scope ON memory_preferences(scope, scope_id)');

    // ── Memory: Associative Links (Layer 5) ──────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        id               TEXT PRIMARY KEY,
        source_id        TEXT NOT NULL,
        source_type      TEXT NOT NULL,
        target_id        TEXT NOT NULL,
        target_type      TEXT NOT NULL,
        relationship     TEXT NOT NULL,
        strength         REAL NOT NULL DEFAULT 0.5,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count     INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mlink_src ON memory_links(source_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mlink_tgt ON memory_links(target_id)');

    // ── Memory: Failure Patterns ─────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_failures (
        id              TEXT PRIMARY KEY,
        tool_name       TEXT NOT NULL,
        error_signature TEXT NOT NULL,
        context         TEXT NOT NULL,
        resolution      TEXT,
        occurrences     INTEGER NOT NULL DEFAULT 1,
        last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mfail_tool ON memory_failures(tool_name)');

    // ── Schedules ────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        cron               TEXT NOT NULL,
        task_description   TEXT NOT NULL,
        budget_preset      TEXT NOT NULL DEFAULT 'medium',
        enabled            INTEGER NOT NULL DEFAULT 1,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        last_run_at        TEXT,
        last_run_status    TEXT,
        run_count          INTEGER NOT NULL DEFAULT 0,
        total_energy_wh    REAL NOT NULL DEFAULT 0,
        total_carbon_grams REAL NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sched_en ON schedules(enabled)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id   TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        task_id       TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        completed_at  TEXT NOT NULL,
        status        TEXT NOT NULL,
        energy_wh     REAL NOT NULL DEFAULT 0,
        carbon_grams  REAL NOT NULL DEFAULT 0,
        tokens_used   INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_schlog_sid ON schedule_logs(schedule_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_schlog_at ON schedule_logs(started_at)');

    // ── Users ────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id                  TEXT PRIMARY KEY,
        username            TEXT NOT NULL UNIQUE,
        password_hash       TEXT NOT NULL,
        role                TEXT NOT NULL DEFAULT 'user',
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        quota_max_tokens    INTEGER NOT NULL DEFAULT 1000000,
        quota_max_cost_usd  REAL NOT NULL DEFAULT 10.0,
        quota_max_energy_wh REAL NOT NULL DEFAULT 1.0,
        quota_tokens_used   INTEGER NOT NULL DEFAULT 0,
        quota_cost_used     REAL NOT NULL DEFAULT 0,
        quota_energy_used   REAL NOT NULL DEFAULT 0,
        quota_period_start  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uname ON users(username)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key          TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_apikey_uid ON api_keys(user_id)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_apikey_key ON api_keys(key)');
  },
};
