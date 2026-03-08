/**
 * PgVectorProvider — PostgreSQL + pgvector integration.
 *
 * Requires: `pg` package (optional dependency).
 * Usage:
 *   const pg = new PgVectorProvider({ connectionString: 'postgres://...', dimensions: 384 });
 *   await pg.connect();
 *   await pg.ensureCollection('documents', 384);
 *   await pg.upsert('documents', [{ id: '1', embedding: [...], content: 'hello' }]);
 *   const results = await pg.search('documents', queryVec, { limit: 5 });
 */

import type { VectorProvider, VectorDocument, VectorSearchOptions, VectorSearchResult } from './vector-provider.js';

export interface PgVectorConfig {
  connectionString: string;
  dimensions?: number;
  schema?: string;
}

export class PgVectorProvider implements VectorProvider {
  readonly name = 'pgvector';
  private client: any = null;
  private connected = false;
  private dims: number;
  private schema: string;
  private config: PgVectorConfig;
  private defaultCollection = 'vectors';
  private pendingInserts: Array<{ id: string; vector: number[] }> = [];

  constructor(config: PgVectorConfig) {
    this.config = config;
    this.dims = config.dimensions ?? 384;
    this.schema = config.schema ?? 'public';
  }

  async connect(): Promise<void> {
    try {
      // @ts-expect-error — pg is an optional dependency
      const pg = await import('pg');
      const Client = pg.default?.Client ?? pg.Client;
      this.client = new Client({ connectionString: this.config.connectionString });
      await this.client.connect();

      // Enable pgvector extension
      await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
      this.connected = true;
    } catch (err) {
      throw new Error(`PgVector connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
      this.connected = false;
    }
  }

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    this.assertConnected();
    this.dims = dimensions;
    this.defaultCollection = name;

    await this.client.query(`
      CREATE TABLE IF NOT EXISTS ${this.schema}.${name} (
        id TEXT PRIMARY KEY,
        embedding vector(${dimensions}),
        content TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create HNSW index for fast ANN search
    await this.client.query(`
      CREATE INDEX IF NOT EXISTS idx_${name}_embedding
      ON ${this.schema}.${name}
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
  }

  async upsert(collection: string, documents: VectorDocument[]): Promise<void> {
    this.assertConnected();

    for (const doc of documents) {
      const vecStr = `[${doc.embedding.join(',')}]`;
      await this.client.query(
        `INSERT INTO ${this.schema}.${collection} (id, embedding, content, metadata)
         VALUES ($1, $2::vector, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           embedding = EXCLUDED.embedding,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata`,
        [doc.id, vecStr, doc.content ?? '', JSON.stringify(doc.metadata ?? {})],
      );
    }
  }

  async search(collection: string, queryVector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]> {
    this.assertConnected();

    const limit = options?.limit ?? 10;
    const vecStr = `[${queryVector.join(',')}]`;

    const result = await this.client.query(
      `SELECT id, content, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM ${this.schema}.${collection}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vecStr, limit],
    );

    return result.rows
      .filter((r: any) => !options?.minScore || r.score >= options.minScore)
      .map((r: any) => ({
        id: r.id,
        score: r.score,
        content: r.content,
        metadata: r.metadata,
      }));
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    this.assertConnected();
    await this.client.query(
      `DELETE FROM ${this.schema}.${collection} WHERE id = ANY($1)`,
      [ids],
    );
  }

  async count(collection: string): Promise<number> {
    this.assertConnected();
    const result = await this.client.query(
      `SELECT COUNT(*) as cnt FROM ${this.schema}.${collection}`,
    );
    return parseInt(result.rows[0].cnt, 10);
  }

  isAvailable(): boolean {
    return this.connected;
  }

  getDims(): number {
    return this.dims;
  }

  // VectorIndexLike adapter methods (sync wrappers for async operations)

  insert(id: string, vector: number[]): void {
    // Queue for batch insert since this is sync
    this.pendingInserts.push({ id, vector });
    // Auto-flush when batch gets large
    if (this.pendingInserts.length >= 100) {
      this.flushInserts().catch(() => {});
    }
  }

  searchSync(queryVector: number[], limit = 10): Array<{ id: string; distance: number }> {
    // Sync search not supported for pgvector — use search() instead
    return [];
  }

  /** Flush pending inserts to the database. */
  async flushInserts(): Promise<void> {
    if (this.pendingInserts.length === 0) return;
    const batch = this.pendingInserts.splice(0);
    await this.upsert(
      this.defaultCollection,
      batch.map(b => ({ id: b.id, embedding: b.vector })),
    );
  }

  private assertConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error('PgVector not connected. Call connect() first.');
    }
  }
}
