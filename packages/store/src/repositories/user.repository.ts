import type Database from 'better-sqlite3';

// ── Row types ────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  quota_max_tokens: number;
  quota_max_cost_usd: number;
  quota_max_energy_wh: number;
  quota_tokens_used: number;
  quota_cost_used: number;
  quota_energy_used: number;
  quota_period_start: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

// ── Data types (camelCase API) ──────────────────────────────────

export interface UserData {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  createdAt: string;
  quota: {
    maxTokens: number;
    maxCostUsd: number;
    maxEnergyWh: number;
    tokensUsed: number;
    costUsed: number;
    energyUsed: number;
    periodStart: string;
  };
  apiKeys: ApiKeyData[];
}

export interface ApiKeyData {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

// ── Repository ──────────────────────────────────────────────────

export class UserRepository {
  private insertUserStmt: Database.Statement;
  private getUserStmt: Database.Statement;
  private getUserByNameStmt: Database.Statement;
  private deleteUserStmt: Database.Statement;
  private updateQuotaStmt: Database.Statement;
  private deductQuotaStmt: Database.Statement;
  private resetQuotaStmt: Database.Statement;

  private insertApiKeyStmt: Database.Statement;
  private getApiKeysByUserStmt: Database.Statement;
  private getApiKeyStmt: Database.Statement;
  private deleteApiKeyStmt: Database.Statement;
  private updateApiKeyUsedStmt: Database.Statement;

  // For efficient lookups: api_key.key → user_id
  private getUserByApiKeyStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // ── User statements
    this.insertUserStmt = db.prepare(`
      INSERT OR REPLACE INTO users
        (id, username, password_hash, role, created_at,
         quota_max_tokens, quota_max_cost_usd, quota_max_energy_wh,
         quota_tokens_used, quota_cost_used, quota_energy_used, quota_period_start)
      VALUES
        (@id, @username, @password_hash, @role, @created_at,
         @quota_max_tokens, @quota_max_cost_usd, @quota_max_energy_wh,
         @quota_tokens_used, @quota_cost_used, @quota_energy_used, @quota_period_start)
    `);

    this.getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
    this.getUserByNameStmt = db.prepare('SELECT * FROM users WHERE username = ?');
    this.deleteUserStmt = db.prepare('DELETE FROM users WHERE id = ?');

    this.updateQuotaStmt = db.prepare(`
      UPDATE users SET
        quota_max_tokens = @quota_max_tokens,
        quota_max_cost_usd = @quota_max_cost_usd,
        quota_max_energy_wh = @quota_max_energy_wh,
        quota_tokens_used = @quota_tokens_used,
        quota_cost_used = @quota_cost_used,
        quota_energy_used = @quota_energy_used,
        quota_period_start = @quota_period_start
      WHERE id = @id
    `);

    this.deductQuotaStmt = db.prepare(`
      UPDATE users SET
        quota_tokens_used = quota_tokens_used + @tokens,
        quota_cost_used = quota_cost_used + @cost,
        quota_energy_used = quota_energy_used + @energy
      WHERE id = @id
    `);

    this.resetQuotaStmt = db.prepare(`
      UPDATE users SET
        quota_tokens_used = 0,
        quota_cost_used = 0,
        quota_energy_used = 0,
        quota_period_start = ?
      WHERE id = ?
    `);

    // ── API key statements
    this.insertApiKeyStmt = db.prepare(`
      INSERT OR REPLACE INTO api_keys (id, user_id, key, name, created_at, last_used_at)
      VALUES (@id, @user_id, @key, @name, @created_at, @last_used_at)
    `);

    this.getApiKeysByUserStmt = db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC');
    this.getApiKeyStmt = db.prepare('SELECT * FROM api_keys WHERE key = ?');
    this.deleteApiKeyStmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
    this.updateApiKeyUsedStmt = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE key = ?');

    // Join-based lookup: find user by API key
    this.getUserByApiKeyStmt = db.prepare(`
      SELECT u.* FROM users u
      INNER JOIN api_keys ak ON ak.user_id = u.id
      WHERE ak.key = ?
    `);
  }

  save(user: UserData): void {
    const saveTx = this.db.transaction(() => {
      this.insertUserStmt.run({
        id: user.id,
        username: user.username,
        password_hash: user.passwordHash,
        role: user.role,
        created_at: user.createdAt,
        quota_max_tokens: user.quota.maxTokens,
        quota_max_cost_usd: user.quota.maxCostUsd,
        quota_max_energy_wh: user.quota.maxEnergyWh,
        quota_tokens_used: user.quota.tokensUsed,
        quota_cost_used: user.quota.costUsed,
        quota_energy_used: user.quota.energyUsed,
        quota_period_start: user.quota.periodStart,
      });

      // Sync API keys: delete existing and re-insert
      this.db.prepare('DELETE FROM api_keys WHERE user_id = ?').run(user.id);
      for (const key of user.apiKeys) {
        this.insertApiKeyStmt.run({
          id: key.id,
          user_id: user.id,
          key: key.key,
          name: key.name,
          created_at: key.createdAt,
          last_used_at: key.lastUsedAt ?? null,
        });
      }
    });
    saveTx();
  }

  getById(id: string): UserData | null {
    const row = this.getUserStmt.get(id) as UserRow | undefined;
    if (!row) return null;
    return this.buildUserData(row);
  }

  getByUsername(username: string): UserData | null {
    const row = this.getUserByNameStmt.get(username) as UserRow | undefined;
    if (!row) return null;
    return this.buildUserData(row);
  }

  getByApiKey(key: string): UserData | null {
    const row = this.getUserByApiKeyStmt.get(key) as UserRow | undefined;
    if (!row) return null;
    return this.buildUserData(row);
  }

  list(): UserData[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as UserRow[];
    return rows.map(r => this.buildUserData(r));
  }

  delete(id: string): boolean {
    // CASCADE on api_keys handles cleanup
    const result = this.deleteUserStmt.run(id);
    return result.changes > 0;
  }

  saveApiKey(userId: string, apiKey: ApiKeyData): void {
    this.insertApiKeyStmt.run({
      id: apiKey.id,
      user_id: userId,
      key: apiKey.key,
      name: apiKey.name,
      created_at: apiKey.createdAt,
      last_used_at: apiKey.lastUsedAt ?? null,
    });
  }

  deleteApiKey(userId: string, keyId: string): boolean {
    const result = this.deleteApiKeyStmt.run(keyId, userId);
    return result.changes > 0;
  }

  updateApiKeyLastUsed(key: string): void {
    this.updateApiKeyUsedStmt.run(new Date().toISOString(), key);
  }

  deductQuota(userId: string, tokens: number, costUsd: number, energyWh: number): void {
    this.deductQuotaStmt.run({
      id: userId,
      tokens,
      cost: costUsd,
      energy: energyWh,
    });
  }

  resetQuota(userId: string): void {
    this.resetQuotaStmt.run(new Date().toISOString(), userId);
  }

  private buildUserData(row: UserRow): UserData {
    const apiKeyRows = this.getApiKeysByUserStmt.all(row.id) as ApiKeyRow[];
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      createdAt: row.created_at,
      quota: {
        maxTokens: row.quota_max_tokens,
        maxCostUsd: row.quota_max_cost_usd,
        maxEnergyWh: row.quota_max_energy_wh,
        tokensUsed: row.quota_tokens_used,
        costUsed: row.quota_cost_used,
        energyUsed: row.quota_energy_used,
        periodStart: row.quota_period_start,
      },
      apiKeys: apiKeyRows.map(k => ({
        id: k.id,
        key: k.key,
        name: k.name,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at ?? undefined,
      })),
    };
  }
}
