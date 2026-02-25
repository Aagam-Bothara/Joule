import type Database from 'better-sqlite3';

// ── Interfaces ────────────────────────────────────────────────────

export interface SemanticRow {
  id: string;
  key: string;
  value: string;       // JSON
  category: string;
  source: string;
  confidence: number;
  scope: string;
  scope_id: string | null;
  tags: string | null;  // JSON array
  supersedes: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface EpisodicRow {
  id: string;
  task_id: string;
  summary: string;
  outcome: string;
  tools_used: string | null;    // JSON array
  steps_completed: number;
  total_steps: number;
  energy_used: number;
  carbon_used: number;
  cost_usd: number;
  duration_ms: number;
  scope: string;
  scope_id: string | null;
  context: string | null;
  lessons_learned: string | null;
  tags: string | null;          // JSON array
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface ProceduralRow {
  id: string;
  name: string;
  description: string;
  pattern: string;     // JSON
  confidence: number;
  success_rate: number;
  times_used: number;
  scope: string;
  scope_id: string | null;
  tags: string | null;  // JSON array
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface PreferenceRow {
  id: string;
  key: string;
  value: string;       // JSON
  learned_from: string;
  confidence: number;
  scope: string;
  scope_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface LinkRow {
  id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  relationship: string;
  strength: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  access_count: number;
}

export interface FailureRow {
  id: string;
  tool_name: string;
  error_signature: string;
  context: string;
  resolution: string | null;
  occurrences: number;
  last_seen: string;
}

// ── Data shapes for the API ──────────────────────────────────────

export interface SemanticData {
  id: string;
  key: string;
  value: unknown;
  category: string;
  source: string;
  confidence: number;
  scope: string;
  scopeId?: string;
  tags: string[];
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export interface EpisodicData {
  id: string;
  taskId: string;
  summary: string;
  outcome: string;
  toolsUsed: string[];
  stepsCompleted: number;
  totalSteps: number;
  energyUsed: number;
  carbonUsed: number;
  costUsd: number;
  durationMs: number;
  scope: string;
  scopeId?: string;
  context?: string;
  lessonsLearned?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export interface ProceduralData {
  id: string;
  name: string;
  description: string;
  pattern: unknown;
  confidence: number;
  successRate: number;
  timesUsed: number;
  scope: string;
  scopeId?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export interface PreferenceData {
  id: string;
  key: string;
  value: unknown;
  learnedFrom: string;
  confidence: number;
  scope: string;
  scopeId?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export interface LinkData {
  id: string;
  sourceId: string;
  sourceType: string;
  targetId: string;
  targetType: string;
  relationship: string;
  strength: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export interface FailureData {
  id: string;
  toolName: string;
  errorSignature: string;
  context: string;
  resolution?: string;
  occurrences: number;
  lastSeen: string;
}

export interface MemoryCounts {
  semantic: number;
  episodic: number;
  procedural: number;
  preferences: number;
  links: number;
  failures: number;
}

export interface BulkMemoryData {
  semantic?: SemanticData[];
  episodic?: EpisodicData[];
  procedural?: ProceduralData[];
  preferences?: PreferenceData[];
  links?: LinkData[];
  failures?: FailureData[];
}

export interface SemanticSearchOptions {
  key?: string;
  category?: string;
  scope?: string;
  scopeId?: string;
  tags?: string[];
  minConfidence?: number;
  limit?: number;
  offset?: number;
}

export interface EpisodicSearchOptions {
  outcome?: string;
  scope?: string;
  scopeId?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}

// ── Repository ───────────────────────────────────────────────────

export class MemoryRepository {
  // ── Semantic statements
  private insertSemanticStmt: Database.Statement;
  private getSemanticStmt: Database.Statement;
  private getSemanticByKeyStmt: Database.Statement;
  private updateSemanticConfStmt: Database.Statement;
  private supersedeSemanticStmt: Database.Statement;
  private deleteSemanticStmt: Database.Statement;
  private touchSemanticStmt: Database.Statement;

  // ── Episodic statements
  private insertEpisodicStmt: Database.Statement;
  private getEpisodicStmt: Database.Statement;

  // ── Procedural statements
  private insertProceduralStmt: Database.Statement;
  private getProceduralStmt: Database.Statement;
  private getProceduralByNameStmt: Database.Statement;
  private updateProceduralUsageStmt: Database.Statement;

  // ── Preference statements
  private insertPreferenceStmt: Database.Statement;
  private getPreferenceStmt: Database.Statement;
  private getPreferenceByKeyStmt: Database.Statement;

  // ── Link statements
  private insertLinkStmt: Database.Statement;
  private getLinksBySourceStmt: Database.Statement;
  private getLinksByTargetStmt: Database.Statement;
  private deleteLinkStmt: Database.Statement;

  // ── Failure statements
  private insertFailureStmt: Database.Statement;
  private getFailureStmt: Database.Statement;
  private getFailureByToolStmt: Database.Statement;
  private updateFailureStmt: Database.Statement;

  constructor(private db: Database.Database) {
    // ── Semantic ──────────────────────────────────────────────────
    this.insertSemanticStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_semantic
        (id, key, value, category, source, confidence, scope, scope_id, tags,
         supersedes, superseded_by, created_at, updated_at, last_accessed_at, access_count)
      VALUES
        (@id, @key, @value, @category, @source, @confidence, @scope, @scope_id, @tags,
         @supersedes, @superseded_by, @created_at, @updated_at, @last_accessed_at, @access_count)
    `);
    this.getSemanticStmt = db.prepare('SELECT * FROM memory_semantic WHERE id = ?');
    this.getSemanticByKeyStmt = db.prepare(
      'SELECT * FROM memory_semantic WHERE key = ? AND superseded_by IS NULL ORDER BY confidence DESC LIMIT 1',
    );
    this.updateSemanticConfStmt = db.prepare(
      'UPDATE memory_semantic SET confidence = ?, updated_at = ? WHERE id = ?',
    );
    this.supersedeSemanticStmt = db.prepare(
      'UPDATE memory_semantic SET superseded_by = ?, updated_at = ? WHERE id = ?',
    );
    this.deleteSemanticStmt = db.prepare('DELETE FROM memory_semantic WHERE id = ?');
    this.touchSemanticStmt = db.prepare(
      'UPDATE memory_semantic SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?',
    );

    // ── Episodic ──────────────────────────────────────────────────
    this.insertEpisodicStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_episodic
        (id, task_id, summary, outcome, tools_used, steps_completed, total_steps,
         energy_used, carbon_used, cost_usd, duration_ms, scope, scope_id,
         context, lessons_learned, tags, created_at, updated_at, last_accessed_at, access_count)
      VALUES
        (@id, @task_id, @summary, @outcome, @tools_used, @steps_completed, @total_steps,
         @energy_used, @carbon_used, @cost_usd, @duration_ms, @scope, @scope_id,
         @context, @lessons_learned, @tags, @created_at, @updated_at, @last_accessed_at, @access_count)
    `);
    this.getEpisodicStmt = db.prepare('SELECT * FROM memory_episodic WHERE id = ?');

    // ── Procedural ────────────────────────────────────────────────
    this.insertProceduralStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_procedural
        (id, name, description, pattern, confidence, success_rate, times_used,
         scope, scope_id, tags, created_at, updated_at, last_accessed_at, access_count)
      VALUES
        (@id, @name, @description, @pattern, @confidence, @success_rate, @times_used,
         @scope, @scope_id, @tags, @created_at, @updated_at, @last_accessed_at, @access_count)
    `);
    this.getProceduralStmt = db.prepare('SELECT * FROM memory_procedural WHERE id = ?');
    this.getProceduralByNameStmt = db.prepare(
      'SELECT * FROM memory_procedural WHERE name = ? AND scope = ? LIMIT 1',
    );
    this.updateProceduralUsageStmt = db.prepare(
      'UPDATE memory_procedural SET times_used = ?, success_rate = ?, confidence = ?, updated_at = ? WHERE id = ?',
    );

    // ── Preferences ───────────────────────────────────────────────
    this.insertPreferenceStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_preferences
        (id, key, value, learned_from, confidence, scope, scope_id,
         created_at, updated_at, last_accessed_at, access_count)
      VALUES
        (@id, @key, @value, @learned_from, @confidence, @scope, @scope_id,
         @created_at, @updated_at, @last_accessed_at, @access_count)
    `);
    this.getPreferenceStmt = db.prepare('SELECT * FROM memory_preferences WHERE id = ?');
    this.getPreferenceByKeyStmt = db.prepare(
      'SELECT * FROM memory_preferences WHERE key = ? ORDER BY confidence DESC LIMIT 1',
    );

    // ── Links ─────────────────────────────────────────────────────
    this.insertLinkStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_links
        (id, source_id, source_type, target_id, target_type, relationship, strength,
         created_at, updated_at, last_accessed_at, access_count)
      VALUES
        (@id, @source_id, @source_type, @target_id, @target_type, @relationship, @strength,
         @created_at, @updated_at, @last_accessed_at, @access_count)
    `);
    this.getLinksBySourceStmt = db.prepare('SELECT * FROM memory_links WHERE source_id = ?');
    this.getLinksByTargetStmt = db.prepare('SELECT * FROM memory_links WHERE target_id = ?');
    this.deleteLinkStmt = db.prepare('DELETE FROM memory_links WHERE id = ?');

    // ── Failures ──────────────────────────────────────────────────
    this.insertFailureStmt = db.prepare(`
      INSERT OR REPLACE INTO memory_failures
        (id, tool_name, error_signature, context, resolution, occurrences, last_seen)
      VALUES
        (@id, @tool_name, @error_signature, @context, @resolution, @occurrences, @last_seen)
    `);
    this.getFailureStmt = db.prepare('SELECT * FROM memory_failures WHERE id = ?');
    this.getFailureByToolStmt = db.prepare(
      'SELECT * FROM memory_failures WHERE tool_name = ? ORDER BY occurrences DESC',
    );
    this.updateFailureStmt = db.prepare(
      'UPDATE memory_failures SET occurrences = ?, last_seen = ?, resolution = ? WHERE id = ?',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  SEMANTIC MEMORY
  // ═══════════════════════════════════════════════════════════════

  saveSemantic(data: SemanticData): void {
    this.insertSemanticStmt.run({
      id: data.id,
      key: data.key,
      value: JSON.stringify(data.value),
      category: data.category,
      source: data.source,
      confidence: data.confidence,
      scope: data.scope,
      scope_id: data.scopeId ?? null,
      tags: data.tags.length > 0 ? JSON.stringify(data.tags) : null,
      supersedes: data.supersedes ?? null,
      superseded_by: data.supersededBy ?? null,
      created_at: data.createdAt,
      updated_at: data.updatedAt,
      last_accessed_at: data.lastAccessedAt,
      access_count: data.accessCount,
    });
  }

  getSemantic(id: string): SemanticData | null {
    const row = this.getSemanticStmt.get(id) as SemanticRow | undefined;
    if (!row) return null;
    this.touchSemanticStmt.run(new Date().toISOString(), id);
    return this.parseSemanticRow(row);
  }

  getSemanticByKey(key: string): SemanticData | null {
    const row = this.getSemanticByKeyStmt.get(key) as SemanticRow | undefined;
    if (!row) return null;
    this.touchSemanticStmt.run(new Date().toISOString(), row.id);
    return this.parseSemanticRow(row);
  }

  searchSemantic(options?: SemanticSearchOptions): SemanticData[] {
    const conditions: string[] = ['superseded_by IS NULL'];
    const params: unknown[] = [];

    if (options?.key) {
      conditions.push('key LIKE ?');
      params.push(`%${options.key}%`);
    }
    if (options?.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }
    if (options?.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }
    if (options?.scopeId) {
      conditions.push('scope_id = ?');
      params.push(options.scopeId);
    }
    if (options?.minConfidence != null) {
      conditions.push('confidence >= ?');
      params.push(options.minConfidence);
    }
    if (options?.tags && options.tags.length > 0) {
      // Search for any matching tag within the JSON array
      const tagConditions = options.tags.map(() => "tags LIKE ?");
      conditions.push(`(${tagConditions.join(' OR ')})`);
      for (const tag of options.tags) {
        params.push(`%"${tag}"%`);
      }
    }

    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    params.push(limit, offset);

    const sql = `SELECT * FROM memory_semantic WHERE ${conditions.join(' AND ')} ORDER BY confidence DESC, updated_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as SemanticRow[];
    return rows.map(r => this.parseSemanticRow(r));
  }

  updateSemanticConfidence(id: string, confidence: number): void {
    this.updateSemanticConfStmt.run(confidence, new Date().toISOString(), id);
  }

  supersedeSemantic(oldId: string, newId: string): void {
    this.supersedeSemanticStmt.run(newId, new Date().toISOString(), oldId);
  }

  deleteSemanticBelow(minConfidence: number, olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db.prepare(
      'DELETE FROM memory_semantic WHERE confidence < ? AND updated_at < ? AND superseded_by IS NULL',
    ).run(minConfidence, cutoff);
    return result.changes;
  }

  getAllSemantic(options?: { includeSuperseded?: boolean }): SemanticData[] {
    const sql = options?.includeSuperseded
      ? 'SELECT * FROM memory_semantic ORDER BY updated_at DESC'
      : 'SELECT * FROM memory_semantic WHERE superseded_by IS NULL ORDER BY updated_at DESC';
    const rows = this.db.prepare(sql).all() as SemanticRow[];
    return rows.map(r => this.parseSemanticRow(r));
  }

  // ═══════════════════════════════════════════════════════════════
  //  EPISODIC MEMORY
  // ═══════════════════════════════════════════════════════════════

  saveEpisodic(data: EpisodicData): void {
    this.insertEpisodicStmt.run({
      id: data.id,
      task_id: data.taskId,
      summary: data.summary,
      outcome: data.outcome,
      tools_used: data.toolsUsed.length > 0 ? JSON.stringify(data.toolsUsed) : null,
      steps_completed: data.stepsCompleted,
      total_steps: data.totalSteps,
      energy_used: data.energyUsed,
      carbon_used: data.carbonUsed,
      cost_usd: data.costUsd,
      duration_ms: data.durationMs,
      scope: data.scope,
      scope_id: data.scopeId ?? null,
      context: data.context ?? null,
      lessons_learned: data.lessonsLearned ?? null,
      tags: data.tags.length > 0 ? JSON.stringify(data.tags) : null,
      created_at: data.createdAt,
      updated_at: data.updatedAt,
      last_accessed_at: data.lastAccessedAt,
      access_count: data.accessCount,
    });
  }

  getRecentEpisodic(limit?: number, scope?: string, scopeId?: string): EpisodicData[] {
    let sql = 'SELECT * FROM memory_episodic';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (scope) {
      conditions.push('scope = ?');
      params.push(scope);
    }
    if (scopeId) {
      conditions.push('scope_id = ?');
      params.push(scopeId);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit ?? 50);

    const rows = this.db.prepare(sql).all(...params) as EpisodicRow[];
    return rows.map(r => this.parseEpisodicRow(r));
  }

  searchEpisodic(options?: EpisodicSearchOptions): EpisodicData[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.outcome) {
      conditions.push('outcome = ?');
      params.push(options.outcome);
    }
    if (options?.scope) {
      conditions.push('scope = ?');
      params.push(options.scope);
    }
    if (options?.scopeId) {
      conditions.push('scope_id = ?');
      params.push(options.scopeId);
    }
    if (options?.tags && options.tags.length > 0) {
      const tagConditions = options.tags.map(() => "tags LIKE ?");
      conditions.push(`(${tagConditions.join(' OR ')})`);
      for (const tag of options.tags) {
        params.push(`%"${tag}"%`);
      }
    }

    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    params.push(limit, offset);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM memory_episodic ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as EpisodicRow[];
    return rows.map(r => this.parseEpisodicRow(r));
  }

  getAllEpisodic(): EpisodicData[] {
    const rows = this.db.prepare('SELECT * FROM memory_episodic ORDER BY created_at DESC').all() as EpisodicRow[];
    return rows.map(r => this.parseEpisodicRow(r));
  }

  pruneEpisodic(keepCount: number): number {
    // Keep the most recent `keepCount` episodes, delete the rest
    const result = this.db.prepare(`
      DELETE FROM memory_episodic WHERE id NOT IN (
        SELECT id FROM memory_episodic ORDER BY created_at DESC LIMIT ?
      )
    `).run(keepCount);
    return result.changes;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROCEDURAL MEMORY
  // ═══════════════════════════════════════════════════════════════

  saveProcedural(data: ProceduralData): void {
    this.insertProceduralStmt.run({
      id: data.id,
      name: data.name,
      description: data.description,
      pattern: JSON.stringify(data.pattern),
      confidence: data.confidence,
      success_rate: data.successRate,
      times_used: data.timesUsed,
      scope: data.scope,
      scope_id: data.scopeId ?? null,
      tags: data.tags.length > 0 ? JSON.stringify(data.tags) : null,
      created_at: data.createdAt,
      updated_at: data.updatedAt,
      last_accessed_at: data.lastAccessedAt,
      access_count: data.accessCount,
    });
  }

  getProceduralByName(name: string, scope: string = 'project'): ProceduralData | null {
    const row = this.getProceduralByNameStmt.get(name, scope) as ProceduralRow | undefined;
    if (!row) return null;
    return this.parseProceduralRow(row);
  }

  getAllProcedural(): ProceduralData[] {
    const rows = this.db.prepare('SELECT * FROM memory_procedural ORDER BY times_used DESC').all() as ProceduralRow[];
    return rows.map(r => this.parseProceduralRow(r));
  }

  updateProceduralUsage(id: string, timesUsed: number, successRate: number, confidence: number): void {
    this.updateProceduralUsageStmt.run(timesUsed, successRate, confidence, new Date().toISOString(), id);
  }

  // ═══════════════════════════════════════════════════════════════
  //  PREFERENCES
  // ═══════════════════════════════════════════════════════════════

  savePreference(data: PreferenceData): void {
    this.insertPreferenceStmt.run({
      id: data.id,
      key: data.key,
      value: JSON.stringify(data.value),
      learned_from: data.learnedFrom,
      confidence: data.confidence,
      scope: data.scope,
      scope_id: data.scopeId ?? null,
      created_at: data.createdAt,
      updated_at: data.updatedAt,
      last_accessed_at: data.lastAccessedAt,
      access_count: data.accessCount,
    });
  }

  getPreference(key: string): PreferenceData | null {
    const row = this.getPreferenceByKeyStmt.get(key) as PreferenceRow | undefined;
    if (!row) return null;
    return this.parsePreferenceRow(row);
  }

  getAllPreferences(scope?: string): PreferenceData[] {
    let sql = 'SELECT * FROM memory_preferences';
    const params: unknown[] = [];
    if (scope) {
      sql += ' WHERE scope = ?';
      params.push(scope);
    }
    sql += ' ORDER BY updated_at DESC';
    const rows = this.db.prepare(sql).all(...params) as PreferenceRow[];
    return rows.map(r => this.parsePreferenceRow(r));
  }

  // ═══════════════════════════════════════════════════════════════
  //  ASSOCIATIVE LINKS
  // ═══════════════════════════════════════════════════════════════

  saveLink(data: LinkData): void {
    this.insertLinkStmt.run({
      id: data.id,
      source_id: data.sourceId,
      source_type: data.sourceType,
      target_id: data.targetId,
      target_type: data.targetType,
      relationship: data.relationship,
      strength: data.strength,
      created_at: data.createdAt,
      updated_at: data.updatedAt,
      last_accessed_at: data.lastAccessedAt,
      access_count: data.accessCount,
    });
  }

  getLinked(id: string, relationship?: string): LinkData[] {
    const sourceLinks = this.getLinksBySourceStmt.all(id) as LinkRow[];
    const targetLinks = this.getLinksByTargetStmt.all(id) as LinkRow[];
    let all = [...sourceLinks, ...targetLinks];

    if (relationship) {
      all = all.filter(l => l.relationship === relationship);
    }

    // Deduplicate by id
    const seen = new Set<string>();
    const unique: LinkRow[] = [];
    for (const link of all) {
      if (!seen.has(link.id)) {
        seen.add(link.id);
        unique.push(link);
      }
    }

    return unique.map(r => this.parseLinkRow(r));
  }

  pruneOrphanLinks(): number {
    // Remove links whose source or target no longer exists in any memory table
    const result = this.db.prepare(`
      DELETE FROM memory_links WHERE
        (source_type = 'semantic' AND source_id NOT IN (SELECT id FROM memory_semantic)) OR
        (source_type = 'episodic' AND source_id NOT IN (SELECT id FROM memory_episodic)) OR
        (source_type = 'procedural' AND source_id NOT IN (SELECT id FROM memory_procedural)) OR
        (source_type = 'preference' AND source_id NOT IN (SELECT id FROM memory_preferences)) OR
        (target_type = 'semantic' AND target_id NOT IN (SELECT id FROM memory_semantic)) OR
        (target_type = 'episodic' AND target_id NOT IN (SELECT id FROM memory_episodic)) OR
        (target_type = 'procedural' AND target_id NOT IN (SELECT id FROM memory_procedural)) OR
        (target_type = 'preference' AND target_id NOT IN (SELECT id FROM memory_preferences))
    `).run();
    return result.changes;
  }

  getAllLinks(): LinkData[] {
    const rows = this.db.prepare('SELECT * FROM memory_links ORDER BY strength DESC').all() as LinkRow[];
    return rows.map(r => this.parseLinkRow(r));
  }

  // ═══════════════════════════════════════════════════════════════
  //  FAILURE PATTERNS
  // ═══════════════════════════════════════════════════════════════

  saveFailure(data: FailureData): void {
    this.insertFailureStmt.run({
      id: data.id,
      tool_name: data.toolName,
      error_signature: data.errorSignature,
      context: data.context,
      resolution: data.resolution ?? null,
      occurrences: data.occurrences,
      last_seen: data.lastSeen,
    });
  }

  getFailure(id: string): FailureData | null {
    const row = this.getFailureStmt.get(id) as FailureRow | undefined;
    if (!row) return null;
    return this.parseFailureRow(row);
  }

  getFailuresByTool(toolName: string): FailureData[] {
    const rows = this.getFailureByToolStmt.all(toolName) as FailureRow[];
    return rows.map(r => this.parseFailureRow(r));
  }

  updateFailure(id: string, occurrences: number, lastSeen: string, resolution?: string): void {
    this.updateFailureStmt.run(occurrences, lastSeen, resolution ?? null, id);
  }

  getAllFailures(): FailureData[] {
    const rows = this.db.prepare('SELECT * FROM memory_failures ORDER BY occurrences DESC').all() as FailureRow[];
    return rows.map(r => this.parseFailureRow(r));
  }

  // ═══════════════════════════════════════════════════════════════
  //  BULK OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /** Save all memory layers atomically in a single transaction. */
  saveAll(data: BulkMemoryData): void {
    const bulkTx = this.db.transaction(() => {
      if (data.semantic) {
        for (const item of data.semantic) this.saveSemantic(item);
      }
      if (data.episodic) {
        for (const item of data.episodic) this.saveEpisodic(item);
      }
      if (data.procedural) {
        for (const item of data.procedural) this.saveProcedural(item);
      }
      if (data.preferences) {
        for (const item of data.preferences) this.savePreference(item);
      }
      if (data.links) {
        for (const item of data.links) this.saveLink(item);
      }
      if (data.failures) {
        for (const item of data.failures) this.saveFailure(item);
      }
    });
    bulkTx();
  }

  /** Run a function inside a single SQLite transaction for atomicity. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Full-text search across semantic memory using FTS5. */
  ftsSearchSemantic(query: string, limit = 50): SemanticData[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM memory_semantic s
      JOIN memory_semantic_fts fts ON s.id = fts.id
      WHERE memory_semantic_fts MATCH ? AND s.superseded_by IS NULL
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as SemanticRow[];
    return rows.map(r => this.parseSemanticRow(r));
  }

  /** Full-text search across episodic memory using FTS5. */
  ftsSearchEpisodic(query: string, limit = 20): EpisodicData[] {
    const rows = this.db.prepare(`
      SELECT e.* FROM memory_episodic e
      JOIN memory_episodic_fts fts ON e.id = fts.id
      WHERE memory_episodic_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as EpisodicRow[];
    return rows.map(r => this.parseEpisodicRow(r));
  }

  /** Get counts of items in each memory layer. */
  counts(): MemoryCounts {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

    return {
      semantic: count('memory_semantic'),
      episodic: count('memory_episodic'),
      procedural: count('memory_procedural'),
      preferences: count('memory_preferences'),
      links: count('memory_links'),
      failures: count('memory_failures'),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  ROW PARSERS (private)
  // ═══════════════════════════════════════════════════════════════

  private parseSemanticRow(row: SemanticRow): SemanticData {
    return {
      id: row.id,
      key: row.key,
      value: JSON.parse(row.value),
      category: row.category,
      source: row.source,
      confidence: row.confidence,
      scope: row.scope,
      scopeId: row.scope_id ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : [],
      supersedes: row.supersedes ?? undefined,
      supersededBy: row.superseded_by ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    };
  }

  private parseEpisodicRow(row: EpisodicRow): EpisodicData {
    return {
      id: row.id,
      taskId: row.task_id,
      summary: row.summary,
      outcome: row.outcome,
      toolsUsed: row.tools_used ? JSON.parse(row.tools_used) : [],
      stepsCompleted: row.steps_completed,
      totalSteps: row.total_steps,
      energyUsed: row.energy_used,
      carbonUsed: row.carbon_used,
      costUsd: row.cost_usd,
      durationMs: row.duration_ms,
      scope: row.scope,
      scopeId: row.scope_id ?? undefined,
      context: row.context ?? undefined,
      lessonsLearned: row.lessons_learned ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    };
  }

  private parseProceduralRow(row: ProceduralRow): ProceduralData {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      pattern: JSON.parse(row.pattern),
      confidence: row.confidence,
      successRate: row.success_rate,
      timesUsed: row.times_used,
      scope: row.scope,
      scopeId: row.scope_id ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    };
  }

  private parsePreferenceRow(row: PreferenceRow): PreferenceData {
    return {
      id: row.id,
      key: row.key,
      value: JSON.parse(row.value),
      learnedFrom: row.learned_from,
      confidence: row.confidence,
      scope: row.scope,
      scopeId: row.scope_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    };
  }

  private parseLinkRow(row: LinkRow): LinkData {
    return {
      id: row.id,
      sourceId: row.source_id,
      sourceType: row.source_type,
      targetId: row.target_id,
      targetType: row.target_type,
      relationship: row.relationship,
      strength: row.strength,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at,
      accessCount: row.access_count,
    };
  }

  private parseFailureRow(row: FailureRow): FailureData {
    return {
      id: row.id,
      toolName: row.tool_name,
      errorSignature: row.error_signature,
      context: row.context,
      resolution: row.resolution ?? undefined,
      occurrences: row.occurrences,
      lastSeen: row.last_seen,
    };
  }
}
