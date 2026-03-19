/**
 * Learned Execution Path Prediction
 *
 * Six execution paths ordered by energy cost (~4-5x apart each).
 * The classifier selects the optimal path upfront, before any waste occurs.
 */

/** P0: Semantic cache hit — zero LLM calls */
export const PATH_CACHE = 0;
/** P1: Direct SLM answer — single call, minimal prompt */
export const PATH_DIRECT = 1;
/** P2: Template execution — skip planning, execute known pattern */
export const PATH_TEMPLATE = 2;
/** P3: Chunked pipeline — parallel SLM calls over input chunks */
export const PATH_CHUNKED = 3;
/** P4: Planned execution with pruning — full Joule pipeline */
export const PATH_PLANNED = 4;
/** P5: Full LLM escalation — planned + upgraded model tier */
export const PATH_ESCALATED = 5;

export type ExecutionPathId = 0 | 1 | 2 | 3 | 4 | 5;

/** Output of the single-call classifier */
export interface ExecutionProfile {
  path: ExecutionPathId;
  confidence: number;          // 0.0–1.0
  template?: string;           // P2: which template key to use
  chunkSize?: number;          // P3: optimal tokens per chunk
  modelTier: 'slm' | 'llm';
  predictedEnergyWh: number;
  predictedQuality: number;    // 1–5
  rationale: string;           // one sentence, for trace logging
}

/** Outcome logged after every execution (feeds adaptive learner) */
export interface ExecutionOutcome {
  taskId: string;
  taskDescription: string;
  profile: ExecutionProfile;
  actualPath: ExecutionPathId;
  actualEnergyWh: number;
  actualQuality: number;
  actualLatencyMs: number;
  mispredicted: boolean;
  betterPathWouldHaveBeen: ExecutionPathId | null;
  timestamp: string;
}

/** Entry stored in the semantic cache */
export interface CacheEntry {
  id: string;
  taskHash: string;
  taskDescription: string;
  embedding: number[];         // TF-IDF vector
  result: string;
  qualityScore: number;
  energyWh: number;
  pathUsed: ExecutionPathId;
  hitCount: number;
  lastUsed: string;
  createdAt: string;
}

/** Cache lookup result */
export interface CacheResult {
  hit: boolean;
  entry?: CacheEntry;
  similarity?: number;
}

/** Template definition for P2 execution */
export interface TaskTemplate {
  key: string;
  name: string;
  triggerKeywords: string[];
  /** Category tags for matching */
  categories: string[];
  /** Prompt template — use {description}, {code}, {language}, {error} etc. */
  promptTemplate: string;
  /** For chunked templates: chunk prompt + combine prompt */
  chunkPrompt?: string;
  combinePrompt?: string;
  chunkSize?: number;
  modelTier: 'slm' | 'llm';
  /** Estimated energy cost in Wh */
  estimatedEnergyWh: number;
}

/** Config for the execution path system */
export interface ExecutionPathConfig {
  /** Master switch. Default: true */
  enabled: boolean;
  /** Semantic cache config */
  cache: {
    enabled: boolean;
    /** Cosine similarity threshold for a cache hit. Default: 0.92 */
    similarityThreshold: number;
    /** Max cache entries before LRU eviction. Default: 10000 */
    maxEntries: number;
    /** SQLite DB path. Default: .joule/cache.db */
    dbPath: string;
  };
  /** Adaptive learner config */
  learner: {
    enabled: boolean;
    /** Update correction table every N tasks. Default: 20 */
    updateIntervalTasks: number;
    /** Path to persist correction table JSON. Default: .joule/corrections.json */
    correctionTablePath: string;
  };
}
