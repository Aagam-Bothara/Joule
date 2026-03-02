/**
 * VectorIndex — sqlite-vec based vector similarity search.
 *
 * Provides vector storage and nearest-neighbor search using the sqlite-vec
 * extension. Falls back gracefully when the extension is not available.
 */

export interface VectorSearchResult {
  id: string;
  distance: number;
}

/**
 * Simple hash-based embedding function.
 * Produces deterministic, fixed-dimension vectors without external API calls.
 * Uses feature hashing (hashing trick) for vocabulary-independent embedding.
 */
export function hashEmbed(text: string, dims = 384): number[] {
  const tokens = tokenize(text);
  const vec = new Float32Array(dims);

  for (const token of tokens) {
    const hash = simpleHash(token);
    const idx = Math.abs(hash) % dims;
    const sign = hash > 0 ? 1 : -1;
    vec[idx] += sign * (1 / Math.sqrt(Math.max(tokens.length, 1)));
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) vec[i] /= norm;
  }

  return Array.from(vec);
}

/** Tokenize text into lowercase words, filtering stop words. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/** FNV-1a inspired hash for deterministic, fast string hashing. */
function simpleHash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) | 0;
  }
  return hash;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'it', 'as', 'be', 'was', 'are', 'been',
  'this', 'that', 'from', 'has', 'had', 'have', 'not', 'can', 'will',
  'do', 'if', 'so', 'no', 'up', 'out', 'its', 'he', 'she', 'we',
  'you', 'my', 'me', 'all', 'any', 'just', 'than', 'then', 'also',
]);

export class VectorIndex {
  private available = false;
  private dims: number;
  private db: any; // better-sqlite3 Database
  private tableName: string;

  constructor(db: any, tableName = 'vec_embeddings', dims = 384) {
    this.db = db;
    this.tableName = tableName;
    this.dims = dims;
    this.available = this.tryLoadExtension();
    if (this.available) {
      this.createTable();
    }
  }

  /** Attempt to load the sqlite-vec extension. */
  private tryLoadExtension(): boolean {
    try {
      // sqlite-vec installs as 'vec0' extension
      this.db.loadExtension('vec0');
      return true;
    } catch {
      try {
        // Try common paths
        this.db.loadExtension('sqlite-vec');
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Create the virtual table for vector storage. */
  private createTable(): void {
    try {
      // sqlite-vec uses vec0 virtual table module
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName}
        USING vec0(embedding float[${this.dims}])
      `);
      // Metadata table for id mapping (vec0 uses rowid)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ${this.tableName}_meta (
          rowid INTEGER PRIMARY KEY,
          external_id TEXT UNIQUE NOT NULL
        )
      `);
    } catch {
      this.available = false;
    }
  }

  /** Check if sqlite-vec is available and functional. */
  isAvailable(): boolean {
    return this.available;
  }

  /** Insert a vector with an external ID. */
  insert(id: string, vector: number[]): void {
    if (!this.available) return;

    try {
      const info = this.db.prepare(
        `INSERT INTO ${this.tableName}(embedding) VALUES (?)`,
      ).run(JSON.stringify(vector));

      this.db.prepare(
        `INSERT OR REPLACE INTO ${this.tableName}_meta(rowid, external_id) VALUES (?, ?)`,
      ).run(info.lastInsertRowid, id);
    } catch {
      // Silently fail — vector ops are best-effort
    }
  }

  /** Search for nearest neighbors. Returns results sorted by distance. */
  search(queryVector: number[], limit = 10): VectorSearchResult[] {
    if (!this.available) return [];

    try {
      const rows = this.db.prepare(`
        SELECT v.rowid, v.distance, m.external_id
        FROM ${this.tableName} v
        JOIN ${this.tableName}_meta m ON m.rowid = v.rowid
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
      `).all(JSON.stringify(queryVector), limit) as Array<{
        rowid: number;
        distance: number;
        external_id: string;
      }>;

      return rows.map(r => ({
        id: r.external_id,
        distance: r.distance,
      }));
    } catch {
      return [];
    }
  }

  /** Delete a vector by external ID. */
  delete(id: string): void {
    if (!this.available) return;

    try {
      const meta = this.db.prepare(
        `SELECT rowid FROM ${this.tableName}_meta WHERE external_id = ?`,
      ).get(id) as { rowid: number } | undefined;

      if (meta) {
        this.db.prepare(`DELETE FROM ${this.tableName} WHERE rowid = ?`).run(meta.rowid);
        this.db.prepare(`DELETE FROM ${this.tableName}_meta WHERE external_id = ?`).run(id);
      }
    } catch {
      // Silently fail
    }
  }

  /** Get the number of stored vectors. */
  count(): number {
    if (!this.available) return 0;
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM ${this.tableName}_meta`,
      ).get() as { cnt: number };
      return row.cnt;
    } catch {
      return 0;
    }
  }
}
