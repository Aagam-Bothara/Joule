/**
 * SemanticCache (P0)
 *
 * Zero-energy execution for repeated/similar tasks.
 * Uses TF-IDF vectors (no model call, pure CPU) + cosine similarity.
 * Persists to SQLite for durability across sessions.
 *
 * Cache hit rate per category is a new metric for the paper.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { CacheEntry, CacheResult, ExecutionPathId } from '@joule/shared';

const DEFAULT_SIMILARITY_THRESHOLD = 0.92;
const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_DB_PATH = '.joule/cache.json';

/** TF-IDF term → index mapping (built lazily from seen vocabulary) */
type Vocabulary = Map<string, number>;

export class SemanticCache {
  private entries: Map<string, CacheEntry> = new Map();
  private vocabulary: Vocabulary = new Map();
  private readonly similarityThreshold: number;
  private readonly maxEntries: number;
  private readonly dbPath: string;
  private dirty = false;

  constructor(options?: {
    similarityThreshold?: number;
    maxEntries?: number;
    dbPath?: string;
  }) {
    this.similarityThreshold = options?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.dbPath = options?.dbPath ?? DEFAULT_DB_PATH;
    this.load();
  }

  /**
   * Look up a task by semantic similarity.
   * Returns the cached result if similarity > threshold.
   */
  lookup(taskDescription: string): CacheResult {
    if (this.entries.size === 0) {
      return { hit: false };
    }

    const queryVec = this.tfidf(taskDescription);
    let bestSimilarity = 0;
    let bestEntry: CacheEntry | undefined;

    for (const entry of this.entries.values()) {
      const sim = this.cosineSimilarity(queryVec, entry.embedding);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestEntry = entry;
      }
    }

    if (bestSimilarity >= this.similarityThreshold && bestEntry) {
      // Update hit count and last used
      bestEntry.hitCount++;
      bestEntry.lastUsed = new Date().toISOString();
      this.dirty = true;

      return { hit: true, entry: bestEntry, similarity: bestSimilarity };
    }

    return { hit: false, similarity: bestSimilarity };
  }

  /**
   * Store a completed task result in the cache.
   */
  store(
    taskDescription: string,
    result: string,
    qualityScore: number,
    energyWh: number,
    pathUsed: ExecutionPathId,
  ): CacheEntry {
    const id = createHash('sha256').update(taskDescription).digest('hex').slice(0, 16);
    const embedding = this.tfidf(taskDescription);

    const entry: CacheEntry = {
      id,
      taskHash: id,
      taskDescription,
      embedding,
      result,
      qualityScore,
      energyWh,
      pathUsed,
      hitCount: 0,
      lastUsed: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    // LRU eviction if at capacity
    if (this.entries.size >= this.maxEntries) {
      this.evictLRU();
    }

    this.entries.set(id, entry);
    this.dirty = true;

    // Persist asynchronously (fire and forget)
    this.scheduleSave();

    return entry;
  }

  /** Total entries in cache */
  get size(): number {
    return this.entries.size;
  }

  /** Persist cache to disk */
  save(): void {
    if (!this.dirty) return;
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data = {
        vocabulary: Array.from(this.vocabulary.entries()),
        entries: Array.from(this.entries.values()),
      };
      writeFileSync(this.dbPath, JSON.stringify(data), 'utf8');
      this.dirty = false;
    } catch {
      // Non-fatal: cache is in-memory, save failure doesn't break execution
    }
  }

  /** Stats for benchmark metrics */
  getStats(): { size: number; totalHits: number; topEntries: number } {
    let totalHits = 0;
    let topEntries = 0;
    for (const entry of this.entries.values()) {
      totalHits += entry.hitCount;
      if (entry.hitCount > 0) topEntries++;
    }
    return { size: this.entries.size, totalHits, topEntries };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private load(): void {
    try {
      if (!existsSync(this.dbPath)) return;
      const raw = readFileSync(this.dbPath, 'utf8');
      const data = JSON.parse(raw) as {
        vocabulary?: Array<[string, number]>;
        entries?: CacheEntry[];
      };

      if (data.vocabulary) {
        this.vocabulary = new Map(data.vocabulary);
      }
      if (data.entries) {
        for (const entry of data.entries) {
          this.entries.set(entry.id, entry);
        }
      }
    } catch {
      // Corrupted cache — start fresh
      this.entries.clear();
      this.vocabulary.clear();
    }
  }

  private evictLRU(): void {
    // Find least recently used entry
    let oldest: string | undefined;
    let oldestTime = Infinity;

    for (const [id, entry] of this.entries) {
      const t = new Date(entry.lastUsed).getTime();
      if (t < oldestTime) {
        oldestTime = t;
        oldest = id;
      }
    }

    if (oldest) this.entries.delete(oldest);
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.save();
      this.saveTimer = null;
    }, 5000);
  }

  /**
   * Compute TF-IDF vector for a text.
   * Vocabulary is built lazily from all seen texts.
   * Returns a sparse vector (array indexed by vocabulary position).
   */
  private tfidf(text: string): number[] {
    const tokens = this.tokenize(text);
    const termFreq: Map<string, number> = new Map();

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }

    // Add new terms to vocabulary
    for (const term of termFreq.keys()) {
      if (!this.vocabulary.has(term)) {
        this.vocabulary.set(term, this.vocabulary.size);
      }
    }

    const dim = this.vocabulary.size;
    const vec = new Array<number>(dim).fill(0);

    for (const [term, freq] of termFreq) {
      const idx = this.vocabulary.get(term);
      if (idx !== undefined) {
        // TF = freq / total tokens; IDF approximated as log(1 + 1/freq) for simplicity
        vec[idx] = (freq / tokens.length) * Math.log(1 + 1 / freq);
      }
    }

    return vec;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.max(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
      const ai = a[i] ?? 0;
      const bi = b[i] ?? 0;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
