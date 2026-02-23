// ============================================================================
// Joule Optimized Memory System — 5-Layer Cognitive Architecture
// Layers: Working, Episodic, Semantic, Procedural, Associative
// Features: Temporal awareness, semantic search, auto-extraction, scoping
// ============================================================================

// --- Scoping ---

export type MemoryScope = 'global' | 'user' | 'project' | 'session';

export interface MemoryAddress {
  scope: MemoryScope;
  scopeId?: string; // e.g. user ID, project path, session ID
}

// --- Temporal Metadata ---

export interface TemporalMeta {
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  validFrom?: string;  // when this fact became true
  validUntil?: string; // when this fact expired (null = still valid)
  ttlMs?: number;      // auto-expire after this many ms
}

// --- Layer 1: Semantic Memory (Facts & Knowledge) ---

export interface SemanticMemory {
  id: string;
  key: string;
  value: unknown;
  category: string;
  source: string;
  confidence: number;       // 0-1, increases on confirmation, decays over time
  scope: MemoryScope;
  scopeId?: string;
  temporal: TemporalMeta;
  tags: string[];
  embedding?: number[];     // TF-IDF vector for semantic search
  supersedes?: string;      // ID of fact this one replaced
  supersededBy?: string;    // ID of fact that replaced this one
}

// --- Layer 2: Episodic Memory (Task Execution History) ---

export interface EpisodicMemory {
  id: string;
  taskId: string;
  summary: string;
  outcome: 'success' | 'partial' | 'failed';
  toolsUsed: string[];
  stepsCompleted: number;
  totalSteps: number;
  energyUsed: number;
  carbonUsed: number;
  costUsd: number;
  durationMs: number;
  scope: MemoryScope;
  scopeId?: string;
  temporal: TemporalMeta;
  tags: string[];
  embedding?: number[];
  context?: string;         // what the user was trying to do
  lessonsLearned?: string;  // what went wrong or right
}

// --- Layer 3: Procedural Memory (Learned Patterns & Workflows) ---

export interface ProceduralMemory {
  id: string;
  name: string;
  description: string;
  pattern: ProceduralPattern;
  confidence: number;
  successRate: number;      // tracked over executions
  timesUsed: number;
  scope: MemoryScope;
  scopeId?: string;
  temporal: TemporalMeta;
  tags: string[];
  embedding?: number[];
}

export interface ProceduralPattern {
  trigger: string;          // what kind of task triggers this
  steps: ProceduralStep[];
  constraints?: string[];   // conditions that must hold
}

export interface ProceduralStep {
  tool: string;
  argTemplate: Record<string, unknown>;
  description: string;
}

// --- Layer 4: Working Memory (Current Session Context) ---

export interface WorkingMemory {
  sessionId: string;
  activeGoal?: string;
  recentFacts: SemanticMemory[];   // injected relevant facts
  recentEpisodes: EpisodicMemory[]; // similar past tasks
  activePreferences: PreferenceMemory[];
  scratchpad: Record<string, unknown>; // agent's working notes
  contextWindow: ContextItem[];
  updatedAt: string;
}

export interface ContextItem {
  type: 'fact' | 'episode' | 'procedure' | 'preference' | 'user_input';
  content: string;
  relevance: number;        // 0-1, how relevant to current task
  source: string;
}

// --- Layer 5: Associative Memory (Entity Graph) ---

export interface AssociativeLink {
  id: string;
  sourceId: string;
  sourceType: MemoryLayerType;
  targetId: string;
  targetType: MemoryLayerType;
  relationship: string;     // e.g. "caused_by", "related_to", "prerequisite_of"
  strength: number;         // 0-1, how strong the association
  temporal: TemporalMeta;
}

// --- Preferences (Sub-layer of Semantic) ---

export interface PreferenceMemory {
  id: string;
  key: string;
  value: unknown;
  learnedFrom: string;
  confidence: number;
  scope: MemoryScope;
  scopeId?: string;
  temporal: TemporalMeta;
}

// --- Enums & Types ---

export type MemoryLayerType = 'semantic' | 'episodic' | 'procedural' | 'working' | 'associative' | 'preference';

// --- Search ---

export interface MemoryQuery {
  text?: string;            // natural language query for semantic search
  layer?: MemoryLayerType;
  category?: string;
  tags?: string[];
  scope?: MemoryScope;
  scopeId?: string;
  minConfidence?: number;
  maxAge?: number;          // max age in ms
  limit?: number;
  key?: string;             // exact key match
  includeExpired?: boolean; // include superseded/expired facts
}

export interface MemorySearchResult {
  layer: MemoryLayerType;
  items: MemoryItem[];
  totalCount: number;
}

export type MemoryItem = SemanticMemory | EpisodicMemory | ProceduralMemory | PreferenceMemory | AssociativeLink;

// --- Memory Operations ---

export interface MemoryConsolidationResult {
  merged: number;
  pruned: number;
  decayed: number;
  promoted: number;  // working → long-term
}

export interface MemoryStats {
  totalFacts: number;
  totalEpisodes: number;
  totalProcedures: number;
  totalPreferences: number;
  totalLinks: number;
  avgFactConfidence: number;
  avgEpisodeSuccess: number;
  oldestMemory: string;
  newestMemory: string;
  storageBytes: number;
}

// --- Auto-Extraction ---

export interface ExtractedFacts {
  facts: Array<{ key: string; value: string; category: string; confidence: number }>;
  preferences: Array<{ key: string; value: string }>;
  entities: Array<{ name: string; type: string; attributes: Record<string, string> }>;
}

// --- Backward Compatibility ---

export type MemoryFact = SemanticMemory;

export interface MemoryEpisode {
  id: string;
  taskId: string;
  summary: string;
  outcome: 'success' | 'partial' | 'failed';
  toolsUsed: string[];
  energyUsed: number;
  carbonUsed: number;
  timestamp: string;
  tags: string[];
}

export interface MemoryPreference {
  id: string;
  key: string;
  value: unknown;
  learnedFrom: string;
  confidence: number;
  createdAt: string;
}

export interface AgentMemoryStore {
  facts: SemanticMemory[];
  episodes: EpisodicMemory[];
  preferences: PreferenceMemory[];
}

export type MemoryLayer = 'facts' | 'episodes' | 'preferences';
