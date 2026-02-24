import type Database from 'better-sqlite3';

export interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  total_cost_usd: number;
  total_energy_wh: number;
  total_carbon_grams: number;
  total_tokens: number;
}

export interface SessionMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
}

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  metadata: {
    messageCount: number;
    totalCostUsd: number;
    totalEnergyWh: number;
    totalCarbonGrams: number;
    totalTokens: number;
  };
}

export interface SessionListEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export class SessionRepository {
  private upsertSessionStmt: Database.Statement;
  private getSessionStmt: Database.Statement;
  private deleteSessionStmt: Database.Statement;
  private insertMsgStmt: Database.Statement;
  private getMsgsStmt: Database.Statement;
  private deleteMsgsStmt: Database.Statement;
  private countStmt: Database.Statement;
  private updateMetaStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.upsertSessionStmt = db.prepare(`
      INSERT OR REPLACE INTO sessions
        (id, created_at, updated_at, message_count, total_cost_usd, total_energy_wh, total_carbon_grams, total_tokens)
      VALUES
        (@id, @created_at, @updated_at, @message_count, @total_cost_usd, @total_energy_wh, @total_carbon_grams, @total_tokens)
    `);

    this.getSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    this.deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
    this.insertMsgStmt = db.prepare(
      'INSERT INTO session_messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    );
    this.getMsgsStmt = db.prepare(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY id ASC',
    );
    this.deleteMsgsStmt = db.prepare('DELETE FROM session_messages WHERE session_id = ?');
    this.countStmt = db.prepare('SELECT COUNT(*) AS c FROM sessions');
    this.updateMetaStmt = db.prepare(`
      UPDATE sessions SET
        updated_at = @updated_at,
        message_count = @message_count,
        total_cost_usd = @total_cost_usd,
        total_energy_wh = @total_energy_wh,
        total_carbon_grams = @total_carbon_grams,
        total_tokens = @total_tokens
      WHERE id = @id
    `);
  }

  /**
   * Save a complete session (upserts the session row and replaces all messages).
   * Runs in a transaction for atomicity.
   */
  save(session: SessionData): void {
    const saveTx = this.db.transaction(() => {
      this.upsertSessionStmt.run({
        id: session.id,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        message_count: session.metadata.messageCount,
        total_cost_usd: session.metadata.totalCostUsd,
        total_energy_wh: session.metadata.totalEnergyWh,
        total_carbon_grams: session.metadata.totalCarbonGrams,
        total_tokens: session.metadata.totalTokens,
      });

      // Replace all messages
      this.deleteMsgsStmt.run(session.id);
      for (const msg of session.messages) {
        this.insertMsgStmt.run(
          session.id,
          msg.role,
          msg.content,
          msg.timestamp ?? new Date().toISOString(),
        );
      }
    });
    saveTx();
  }

  /** Load a session with all its messages. Returns null if not found. */
  load(id: string): SessionData | null {
    const row = this.getSessionStmt.get(id) as SessionRow | undefined;
    if (!row) return null;

    const msgs = this.getMsgsStmt.all(id) as SessionMessageRow[];

    return {
      id: row.id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: msgs.map(m => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      metadata: {
        messageCount: row.message_count,
        totalCostUsd: row.total_cost_usd,
        totalEnergyWh: row.total_energy_wh,
        totalCarbonGrams: row.total_carbon_grams,
        totalTokens: row.total_tokens,
      },
    };
  }

  /** List sessions sorted by updated_at DESC with a preview of the first message. */
  list(): SessionListEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all() as SessionRow[];

    return rows.map(row => {
      const firstMsg = this.db
        .prepare('SELECT content FROM session_messages WHERE session_id = ? ORDER BY id ASC LIMIT 1')
        .get(row.id) as { content: string } | undefined;

      return {
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        preview: firstMsg?.content?.slice(0, 100) ?? '',
      };
    });
  }

  /** Add a single message to an existing session. */
  addMessage(sessionId: string, message: { role: string; content: string; timestamp?: string }): void {
    this.insertMsgStmt.run(
      sessionId,
      message.role,
      message.content,
      message.timestamp ?? new Date().toISOString(),
    );
    // Bump message count and updated_at
    this.db.prepare(
      'UPDATE sessions SET message_count = message_count + 1, updated_at = ? WHERE id = ?',
    ).run(new Date().toISOString(), sessionId);
  }

  /** Update session metadata (cost, energy, tokens, etc). */
  updateMetadata(
    sessionId: string,
    meta: {
      messageCount?: number;
      totalCostUsd?: number;
      totalEnergyWh?: number;
      totalCarbonGrams?: number;
      totalTokens?: number;
    },
  ): void {
    const current = this.getSessionStmt.get(sessionId) as SessionRow | undefined;
    if (!current) return;

    this.updateMetaStmt.run({
      id: sessionId,
      updated_at: new Date().toISOString(),
      message_count: meta.messageCount ?? current.message_count,
      total_cost_usd: meta.totalCostUsd ?? current.total_cost_usd,
      total_energy_wh: meta.totalEnergyWh ?? current.total_energy_wh,
      total_carbon_grams: meta.totalCarbonGrams ?? current.total_carbon_grams,
      total_tokens: meta.totalTokens ?? current.total_tokens,
    });
  }

  delete(id: string): boolean {
    const result = this.deleteSessionStmt.run(id);
    return result.changes > 0;
  }

  count(): number {
    return (this.countStmt.get() as { c: number }).c;
  }
}
