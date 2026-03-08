/**
 * ChromaProvider — ChromaDB vector database integration.
 *
 * Requires: `chromadb` package (optional dependency).
 * Usage:
 *   const chroma = new ChromaProvider({ url: 'http://localhost:8000', dimensions: 384 });
 *   await chroma.connect();
 *   await chroma.ensureCollection('documents', 384);
 *   await chroma.upsert('documents', [{ id: '1', embedding: [...], content: 'hello' }]);
 *   const results = await chroma.search('documents', queryVec, { limit: 5 });
 */

import type { VectorProvider, VectorDocument, VectorSearchOptions, VectorSearchResult } from './vector-provider.js';

export interface ChromaConfig {
  url?: string;
  dimensions?: number;
  tenant?: string;
  database?: string;
}

export class ChromaProvider implements VectorProvider {
  readonly name = 'chroma';
  private client: any = null;
  private connected = false;
  private dims: number;
  private config: ChromaConfig;
  private collections = new Map<string, any>();
  private defaultCollection = 'vectors';

  constructor(config: ChromaConfig = {}) {
    this.config = config;
    this.dims = config.dimensions ?? 384;
  }

  async connect(): Promise<void> {
    try {
      // @ts-expect-error chromadb is an optional dependency
      const chromadb = await import('chromadb');
      const ChromaClient = chromadb.ChromaClient ?? chromadb.default?.ChromaClient;

      this.client = new ChromaClient({
        path: this.config.url ?? 'http://localhost:8000',
      });

      // Test connection by listing collections
      await this.client.listCollections();
      this.connected = true;
    } catch (err) {
      throw new Error(`Chroma connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.collections.clear();
    this.connected = false;
  }

  async ensureCollection(name: string, dimensions: number): Promise<void> {
    this.assertConnected();
    this.dims = dimensions;
    this.defaultCollection = name;

    const collection = await this.client.getOrCreateCollection({
      name,
      metadata: { 'hnsw:space': 'cosine' },
    });
    this.collections.set(name, collection);
  }

  async upsert(collection: string, documents: VectorDocument[]): Promise<void> {
    const col = await this.getCollection(collection);

    await col.upsert({
      ids: documents.map(d => d.id),
      embeddings: documents.map(d => d.embedding),
      documents: documents.map(d => d.content ?? ''),
      metadatas: documents.map(d => d.metadata ?? {}),
    });
  }

  async search(collection: string, queryVector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]> {
    const col = await this.getCollection(collection);
    const limit = options?.limit ?? 10;

    const results = await col.query({
      queryEmbeddings: [queryVector],
      nResults: limit,
      ...(options?.filter ? { where: options.filter } : {}),
    });

    if (!results.ids?.[0]) return [];

    return results.ids[0].map((id: string, i: number) => {
      const distance = results.distances?.[0]?.[i] ?? 0;
      const score = 1 - distance; // cosine distance → similarity
      return {
        id,
        score,
        content: results.documents?.[0]?.[i] ?? undefined,
        metadata: results.metadatas?.[0]?.[i] ?? undefined,
      };
    }).filter((r: VectorSearchResult) => !options?.minScore || r.score >= options.minScore);
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const col = await this.getCollection(collection);
    await col.delete({ ids });
  }

  async count(collection: string): Promise<number> {
    const col = await this.getCollection(collection);
    return col.count();
  }

  isAvailable(): boolean {
    return this.connected;
  }

  getDims(): number {
    return this.dims;
  }

  // VectorIndexLike adapter methods

  insert(id: string, vector: number[]): void {
    // Fire-and-forget async upsert
    this.upsert(this.defaultCollection, [{ id, embedding: vector }]).catch(() => {});
  }

  searchSync(queryVector: number[], limit = 10): Array<{ id: string; distance: number }> {
    // Sync search not supported for Chroma — use search() instead
    return [];
  }

  private async getCollection(name: string): Promise<any> {
    this.assertConnected();
    if (!this.collections.has(name)) {
      const collection = await this.client.getOrCreateCollection({ name });
      this.collections.set(name, collection);
    }
    return this.collections.get(name)!;
  }

  private assertConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error('Chroma not connected. Call connect() first.');
    }
  }
}
