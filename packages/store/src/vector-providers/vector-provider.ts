/**
 * VectorProvider — common interface for external vector databases.
 *
 * Implementations: PgVectorProvider, ChromaProvider.
 * Each provider can be used standalone or plugged into the RagEngine
 * via the VectorIndexLike interface.
 */

export interface VectorDocument {
  id: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface VectorSearchOptions {
  limit?: number;
  filter?: Record<string, unknown>;
  minScore?: number;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  content?: string;
}

export interface VectorProvider {
  readonly name: string;

  /** Connect to the vector database. */
  connect(): Promise<void>;

  /** Disconnect / clean up. */
  disconnect(): Promise<void>;

  /** Create a collection/table if it doesn't exist. */
  ensureCollection(name: string, dimensions: number): Promise<void>;

  /** Upsert vectors into a collection. */
  upsert(collection: string, documents: VectorDocument[]): Promise<void>;

  /** Search for nearest neighbors. */
  search(collection: string, queryVector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;

  /** Delete vectors by IDs. */
  delete(collection: string, ids: string[]): Promise<void>;

  /** Count vectors in a collection. */
  count(collection: string): Promise<number>;

  /** Check if the provider is available and connected. */
  isAvailable(): boolean;

  /** Get configured embedding dimensions. */
  getDims(): number;

  /** Adapter: insert a single vector (VectorIndexLike compatibility). */
  insert(id: string, vector: number[]): void;

  /** Adapter: search (VectorIndexLike compatibility). */
  searchSync(queryVector: number[], limit?: number): Array<{ id: string; distance: number }>;
}
