/**
 * Joule Optimized Memory System — 5-Layer Cognitive Architecture
 *
 * This is what makes Joule's memory categorically superior to OpenClaw/OpenHands:
 *
 * | Feature                    | OpenClaw | LangChain | MemGPT | Joule  |
 * |----------------------------|----------|-----------|--------|--------|
 * | Cross-session persistence  | No       | Plugin    | Yes    | Yes    |
 * | Semantic search            | No       | pgvector  | No     | TF-IDF |
 * | Temporal awareness         | No       | No        | No     | Yes    |
 * | Auto fact extraction       | No       | LangMem   | No     | Yes    |
 * | Confidence decay           | No       | No        | No     | Yes    |
 * | Procedural learning        | No       | No        | No     | Yes    |
 * | Associative graph          | No       | No        | No     | Yes    |
 * | Working memory injection   | Crude    | Manual    | Yes    | Auto   |
 * | Energy-aware               | No       | No        | No     | Yes    |
 * | Zero external deps         | N/A      | No        | No     | Yes    |
 *
 * All 5 layers with file-based JSON persistence. No SQLite, no vector DB,
 * no external services. Just fast, portable, inspectable JSON files.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type SemanticMemory,
  type EpisodicMemory,
  type ProceduralMemory,
  type PreferenceMemory,
  type AssociativeLink,
  type WorkingMemory,
  type MemoryQuery,
  type MemorySearchResult,
  type MemoryItem,
  type MemoryScope,
  type MemoryLayerType,
  type MemoryConsolidationResult,
  type MemoryStats,
  type ContextItem,
  type FailurePattern,
  generateId,
  isoNow,
} from '@joule/shared';
import type {
  MemoryRepository,
  SemanticData,
  EpisodicData,
  ProceduralData,
  PreferenceData,
  LinkData,
  FailureData,
} from '@joule/store';
import { SemanticIndex } from './semantic-index.js';

const DEFAULT_MEMORY_DIR = '.joule/memory';
const CONFIDENCE_DECAY_RATE = 0.01; // per day
const CONSOLIDATION_INTERVAL_MS = 30 * 60_000; // 30 minutes
const MAX_WORKING_MEMORY_ITEMS = 20;

function createTemporal() {
  const now = isoNow();
  return {
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000);
}

export class OptimizedMemory {
  private memoryDir: string;
  private repo?: MemoryRepository;

  // Layer stores
  private semantics: SemanticMemory[] = [];
  private episodes: EpisodicMemory[] = [];
  private procedures: ProceduralMemory[] = [];
  private preferences: PreferenceMemory[] = [];
  private links: AssociativeLink[] = [];
  private failures: FailurePattern[] = [];
  private working: WorkingMemory | null = null;

  // Semantic search index
  private semanticIndex = new SemanticIndex();
  private episodeIndex = new SemanticIndex();

  // Dirty tracking — only write modified items to SQLite
  private dirtySemantics = new Set<string>();
  private dirtyEpisodes = new Set<string>();
  private dirtyProcedures = new Set<string>();
  private dirtyPreferences = new Set<string>();
  private dirtyLinks = new Set<string>();
  private dirtyFailures = new Set<string>();

  // Index maps for O(1) lookup during dirty saves
  private semanticMap = new Map<string, SemanticMemory>();
  private episodeMap = new Map<string, EpisodicMemory>();

  // Batch mode — defer writes until flushDirty()
  private batchMode = false;

  private loaded = false;
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(baseDir?: string, memoryRepo?: MemoryRepository) {
    this.memoryDir = baseDir ?? path.join(process.cwd(), DEFAULT_MEMORY_DIR);
    this.repo = memoryRepo;
  }

  // ======================================================================
  // Initialization & Persistence
  // ======================================================================

  private async ensureDir(): Promise<void> {
    if (this.repo) return; // No filesystem needed with SQLite
    await fs.mkdir(this.memoryDir, { recursive: true });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    if (this.repo) {
      // SQLite mode — lazy loading. Don't bulk-load everything into memory.
      // Arrays remain empty; read methods query SQLite directly.
      // In-memory SemanticIndex not built — FTS5 handles text search.
      this.loaded = true;
      return;
    }

    // JSON file mode — load everything into memory (original behavior)
    await this.ensureDir();
    this.semantics = await this.readJson<SemanticMemory[]>('semantics.json', []);
    this.episodes = await this.readJson<EpisodicMemory[]>('episodes.json', []);
    this.procedures = await this.readJson<ProceduralMemory[]>('procedures.json', []);
    this.preferences = await this.readJson<PreferenceMemory[]>('preferences.json', []);
    this.links = await this.readJson<AssociativeLink[]>('links.json', []);
    this.failures = await this.readJson<FailurePattern[]>('failures.json', []);

    // Rebuild search indices and index maps (only for JSON mode)
    for (const s of this.semantics) {
      this.semanticIndex.add(s.id, this.semanticToText(s));
      this.semanticMap.set(s.id, s);
    }
    for (const e of this.episodes) {
      this.episodeIndex.add(e.id, this.episodeToText(e));
      this.episodeMap.set(e.id, e);
    }

    this.loaded = true;
  }

  /** Start background consolidation */
  startConsolidation(): void {
    if (this.consolidationTimer) return;
    this.consolidationTimer = setInterval(() => {
      this.consolidate().catch(() => {});
    }, CONSOLIDATION_INTERVAL_MS);
  }

  /** Stop background consolidation */
  stopConsolidation(): void {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
  }

  /** Enable batch mode — defers writes until flushDirty() is called */
  enableBatchMode(): void { this.batchMode = true; }

  /** Disable batch mode */
  disableBatchMode(): void { this.batchMode = false; }

  /** Flush all dirty items to SQLite in a single transaction */
  flushDirty(): void {
    if (!this.repo) return;
    const hasDirty = this.dirtySemantics.size > 0 || this.dirtyEpisodes.size > 0
      || this.dirtyProcedures.size > 0 || this.dirtyPreferences.size > 0
      || this.dirtyLinks.size > 0 || this.dirtyFailures.size > 0;
    if (!hasDirty) return;

    this.repo.transaction(() => {
      this.persistDirtySemantics();
      this.persistDirtyEpisodes();
      this.persistDirtyProcedures();
      this.persistDirtyPreferences();
      this.persistDirtyLinks();
      this.persistDirtyFailures();
    });
  }

  // ======================================================================
  // Layer 1: Semantic Memory (Facts & Knowledge)
  // ======================================================================

  async storeFact(
    key: string,
    value: unknown,
    category: string,
    source: string,
    scope: MemoryScope = 'project',
    scopeId?: string,
    tags: string[] = [],
  ): Promise<SemanticMemory> {
    await this.ensureLoaded();

    // Find existing fact with same key + scope
    let existing: SemanticMemory | undefined;
    if (this.repo) {
      // SQLite mode — search repo directly
      const results = this.repo.searchSemantic({ key, scope, scopeId, limit: 1 });
      if (results.length > 0) {
        existing = this.fromSemanticData(results[0]);
      }
    } else {
      existing = this.semantics.find(
        f => f.key === key && f.scope === scope && f.scopeId === scopeId && !f.supersededBy,
      );
    }

    if (existing) {
      // Update existing — boost confidence
      const oldValue = JSON.stringify(existing.value);
      const newValue = JSON.stringify(value);

      if (oldValue !== newValue) {
        // Value changed — create new fact superseding old one
        const newId = generateId('fact');
        existing.supersededBy = newId;
        existing.temporal.updatedAt = isoNow();

        const newFact: SemanticMemory = {
          id: newId,
          key,
          value,
          category,
          source,
          confidence: Math.min(1, existing.confidence + 0.05),
          scope,
          scopeId,
          temporal: createTemporal(),
          tags: [...new Set([...existing.tags, ...tags])],
          supersedes: existing.id,
        };

        if (this.repo) {
          // SQLite mode — write directly
          this.repo.supersedeSemantic(existing.id, newId);
          this.repo.saveSemantic(this.toSemanticData(newFact));
        } else {
          this.semantics.push(newFact);
          this.semanticMap.set(newFact.id, newFact);
          this.dirtySemantics.add(existing.id);
          this.dirtySemantics.add(newFact.id);
          this.semanticIndex.add(newFact.id, this.semanticToText(newFact));
          await this.saveSemantics();
        }
        return newFact;
      }

      // Same value — just boost confidence
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.temporal.updatedAt = isoNow();
      existing.temporal.accessCount++;
      existing.tags = [...new Set([...existing.tags, ...tags])];

      if (this.repo) {
        this.repo.saveSemantic(this.toSemanticData(existing));
      } else {
        this.dirtySemantics.add(existing.id);
        this.semanticIndex.update(existing.id, this.semanticToText(existing));
        await this.saveSemantics();
      }
      return existing;
    }

    // New fact
    const fact: SemanticMemory = {
      id: generateId('fact'),
      key,
      value,
      category,
      source,
      confidence: 0.5,
      scope,
      scopeId,
      temporal: createTemporal(),
      tags,
    };

    if (this.repo) {
      this.repo.saveSemantic(this.toSemanticData(fact));
    } else {
      this.semantics.push(fact);
      this.semanticMap.set(fact.id, fact);
      this.dirtySemantics.add(fact.id);
      this.semanticIndex.add(fact.id, this.semanticToText(fact));
      await this.saveSemantics();
    }
    return fact;
  }

  async getFact(key: string, scope?: MemoryScope, scopeId?: string): Promise<SemanticMemory | undefined> {
    await this.ensureLoaded();

    // SQLite path — query directly
    if (this.repo) {
      const data = this.repo.getSemanticByKey(key);
      if (!data) return undefined;
      const fact = this.fromSemanticData(data);
      if (scope && fact.scope !== scope) return undefined;
      if (scopeId && fact.scopeId !== scopeId) return undefined;
      return fact;
    }

    // In-memory path
    const fact = this.semantics.find(
      f => f.key === key && !f.supersededBy
        && (!scope || f.scope === scope)
        && (!scopeId || f.scopeId === scopeId),
    );
    if (fact) {
      fact.temporal.accessCount++;
      fact.temporal.lastAccessedAt = isoNow();
    }
    return fact;
  }

  async searchFacts(query: MemoryQuery): Promise<SemanticMemory[]> {
    await this.ensureLoaded();

    // FTS5 path — use SQLite full-text search when repo + text query available
    if (this.repo && query.text) {
      try {
        const ftsResults = this.repo.ftsSearchSemantic(query.text, (query.limit ?? 50) + 20);
        let results = ftsResults.map(d => this.fromSemanticData(d));

        // Apply additional filters on the FTS results
        if (query.scope) results = results.filter(f => f.scope === query.scope);
        if (query.scopeId) results = results.filter(f => f.scopeId === query.scopeId);
        if (query.category) results = results.filter(f => f.category === query.category);
        if (query.minConfidence !== undefined) results = results.filter(f => f.confidence >= query.minConfidence!);
        if (query.key) results = results.filter(f => f.key.includes(query.key!));
        if (query.tags?.length) results = results.filter(f => query.tags!.some(t => f.tags.includes(t)));
        if (query.maxAge) {
          const cutoff = new Date(Date.now() - query.maxAge).toISOString();
          results = results.filter(f => f.temporal.updatedAt >= cutoff);
        }

        return results.slice(0, query.limit ?? 50);
      } catch {
        // FTS5 may not be available (e.g., migration not run yet) — fall through to in-memory
      }
    }

    // In-memory path (JSON mode or non-text queries)
    let results = this.semantics.filter(f => !f.supersededBy || query.includeExpired);

    if (query.scope) results = results.filter(f => f.scope === query.scope);
    if (query.scopeId) results = results.filter(f => f.scopeId === query.scopeId);
    if (query.category) results = results.filter(f => f.category === query.category);
    if (query.minConfidence !== undefined) results = results.filter(f => f.confidence >= query.minConfidence!);
    if (query.key) results = results.filter(f => f.key.includes(query.key!));
    if (query.tags?.length) results = results.filter(f => query.tags!.some(t => f.tags.includes(t)));
    if (query.maxAge) {
      const cutoff = new Date(Date.now() - query.maxAge).toISOString();
      results = results.filter(f => f.temporal.updatedAt >= cutoff);
    }

    // If text query provided, use semantic search for ranking
    if (query.text) {
      const scored = this.semanticIndex.search(query.text, results.length + 50);
      const scoreMap = new Map(scored.map(s => [s.id, s.score]));
      results = results
        .map(f => ({ fact: f, score: scoreMap.get(f.id) ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map(r => r.fact);
    } else {
      results.sort((a, b) => b.confidence - a.confidence);
    }

    return results.slice(0, query.limit ?? 50);
  }

  // ======================================================================
  // Layer 2: Episodic Memory (Task Execution History)
  // ======================================================================

  async recordEpisode(
    taskId: string,
    summary: string,
    outcome: EpisodicMemory['outcome'],
    toolsUsed: string[],
    options: {
      stepsCompleted?: number;
      totalSteps?: number;
      energyUsed?: number;
      carbonUsed?: number;
      costUsd?: number;
      durationMs?: number;
      scope?: MemoryScope;
      scopeId?: string;
      tags?: string[];
      context?: string;
      lessonsLearned?: string;
    } = {},
  ): Promise<EpisodicMemory> {
    await this.ensureLoaded();

    const episode: EpisodicMemory = {
      id: generateId('ep'),
      taskId,
      summary,
      outcome,
      toolsUsed,
      stepsCompleted: options.stepsCompleted ?? 0,
      totalSteps: options.totalSteps ?? 0,
      energyUsed: options.energyUsed ?? 0,
      carbonUsed: options.carbonUsed ?? 0,
      costUsd: options.costUsd ?? 0,
      durationMs: options.durationMs ?? 0,
      scope: options.scope ?? 'project',
      scopeId: options.scopeId,
      temporal: createTemporal(),
      tags: options.tags ?? [],
      context: options.context,
      lessonsLearned: options.lessonsLearned,
    };

    if (this.repo) {
      // SQLite mode — write directly
      this.repo.saveEpisodic(this.toEpisodicData(episode));
    } else {
      this.episodes.push(episode);
      this.episodeMap.set(episode.id, episode);
      this.dirtyEpisodes.add(episode.id);
      this.episodeIndex.add(episode.id, this.episodeToText(episode));
      await this.saveEpisodes();
    }

    // Auto-create associative links to related facts
    await this.autoLink(episode);

    return episode;
  }

  async getRecentEpisodes(limit = 10, scope?: MemoryScope): Promise<EpisodicMemory[]> {
    await this.ensureLoaded();

    // SQLite path — query directly
    if (this.repo) {
      const data = this.repo.getRecentEpisodic(limit, scope);
      return data.map(d => this.fromEpisodicData(d));
    }

    // In-memory path
    let eps = [...this.episodes];
    if (scope) eps = eps.filter(e => e.scope === scope);
    return eps
      .sort((a, b) => b.temporal.createdAt.localeCompare(a.temporal.createdAt))
      .slice(0, limit);
  }

  async searchEpisodes(query: MemoryQuery): Promise<EpisodicMemory[]> {
    await this.ensureLoaded();

    // FTS5 path — use SQLite full-text search when repo + text query available
    if (this.repo && query.text) {
      try {
        const ftsResults = this.repo.ftsSearchEpisodic(query.text, (query.limit ?? 20) + 10);
        let results = ftsResults.map(d => this.fromEpisodicData(d));

        if (query.scope) results = results.filter(e => e.scope === query.scope);
        if (query.tags?.length) results = results.filter(e => query.tags!.some(t => e.tags.includes(t)));
        if (query.maxAge) {
          const cutoff = new Date(Date.now() - query.maxAge).toISOString();
          results = results.filter(e => e.temporal.createdAt >= cutoff);
        }

        return results.slice(0, query.limit ?? 20);
      } catch {
        // FTS5 may not be available — fall through to in-memory
      }
    }

    // In-memory path
    let results = [...this.episodes];

    if (query.scope) results = results.filter(e => e.scope === query.scope);
    if (query.tags?.length) results = results.filter(e => query.tags!.some(t => e.tags.includes(t)));
    if (query.maxAge) {
      const cutoff = new Date(Date.now() - query.maxAge).toISOString();
      results = results.filter(e => e.temporal.createdAt >= cutoff);
    }

    // Semantic search
    if (query.text) {
      const scored = this.episodeIndex.search(query.text, results.length + 50);
      const scoreMap = new Map(scored.map(s => [s.id, s.score]));
      results = results
        .map(e => ({ ep: e, score: scoreMap.get(e.id) ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map(r => r.ep);
    } else {
      results.sort((a, b) => b.temporal.createdAt.localeCompare(a.temporal.createdAt));
    }

    return results.slice(0, query.limit ?? 20);
  }

  /** Find similar past episodes for a given task description */
  async findSimilarEpisodes(taskDescription: string, limit = 5): Promise<EpisodicMemory[]> {
    await this.ensureLoaded();

    // FTS5 path — use SQLite full-text search when repo is available
    if (this.repo) {
      try {
        const ftsResults = this.repo.ftsSearchEpisodic(taskDescription, limit);
        return ftsResults.map(d => this.fromEpisodicData(d));
      } catch {
        // FTS5 may not be available — fall through to in-memory
      }
    }

    // In-memory TF-IDF fallback
    const scored = this.episodeIndex.search(taskDescription, limit);
    return scored
      .map(s => this.episodes.find(e => e.id === s.id)!)
      .filter(Boolean);
  }

  // ======================================================================
  // Layer 3: Procedural Memory (Learned Patterns & Workflows)
  // ======================================================================

  async learnProcedure(
    name: string,
    description: string,
    trigger: string,
    steps: Array<{ tool: string; argTemplate: Record<string, unknown>; description: string }>,
    tags: string[] = [],
    scope: MemoryScope = 'project',
  ): Promise<ProceduralMemory> {
    await this.ensureLoaded();

    // Check if similar procedure exists
    let existing: ProceduralMemory | undefined;
    if (this.repo) {
      const data = this.repo.getProceduralByName(name, scope);
      if (data) existing = this.fromProceduralData(data);
    } else {
      existing = this.procedures.find(p => p.name === name && p.scope === scope);
    }

    if (existing) {
      existing.pattern.steps = steps;
      existing.pattern.trigger = trigger;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.temporal.updatedAt = isoNow();

      if (this.repo) {
        this.repo.saveProcedural(this.toProceduralData(existing));
      } else {
        this.dirtyProcedures.add(existing.id);
        await this.saveProcedures();
      }
      return existing;
    }

    const proc: ProceduralMemory = {
      id: generateId('proc'),
      name,
      description,
      pattern: { trigger, steps },
      confidence: 0.5,
      successRate: 0,
      timesUsed: 0,
      scope,
      temporal: createTemporal(),
      tags,
    };

    if (this.repo) {
      this.repo.saveProcedural(this.toProceduralData(proc));
    } else {
      this.procedures.push(proc);
      this.dirtyProcedures.add(proc.id);
      await this.saveProcedures();
    }
    return proc;
  }

  async findProcedure(taskDescription: string, limit = 3): Promise<ProceduralMemory[]> {
    await this.ensureLoaded();

    // Load procedures — small table, OK to load all
    const procs = this.repo
      ? this.repo.getAllProcedural().map(d => this.fromProceduralData(d))
      : this.procedures;

    // Simple keyword matching against trigger patterns
    const words = taskDescription.toLowerCase().split(/\s+/);
    return procs
      .map(p => ({
        proc: p,
        score: words.filter(w => p.pattern.trigger.toLowerCase().includes(w)).length / words.length,
      }))
      .filter(r => r.score > 0.2)
      .sort((a, b) => b.score - a.score || b.proc.confidence - a.proc.confidence)
      .slice(0, limit)
      .map(r => r.proc);
  }

  async recordProcedureUsage(id: string, success: boolean): Promise<void> {
    await this.ensureLoaded();

    if (this.repo) {
      // SQLite path — read, compute, write
      const allProcs = this.repo.getAllProcedural();
      const data = allProcs.find(p => p.id === id);
      if (!data) return;

      const newTimesUsed = data.timesUsed + 1;
      const newSuccessRate = ((data.successRate * data.timesUsed) + (success ? 1 : 0)) / newTimesUsed;
      const newConfidence = Math.min(1, data.confidence + (success ? 0.05 : -0.1));
      this.repo.updateProceduralUsage(id, newTimesUsed, newSuccessRate, newConfidence);
      return;
    }

    const proc = this.procedures.find(p => p.id === id);
    if (!proc) return;

    proc.timesUsed++;
    proc.successRate = ((proc.successRate * (proc.timesUsed - 1)) + (success ? 1 : 0)) / proc.timesUsed;
    proc.confidence = Math.min(1, proc.confidence + (success ? 0.05 : -0.1));
    proc.temporal.updatedAt = isoNow();
    proc.temporal.lastAccessedAt = isoNow();
    this.dirtyProcedures.add(proc.id);
    await this.saveProcedures();
  }

  // ======================================================================
  // Layer 4: Working Memory (Current Session Context)
  // ======================================================================

  async getWorkingMemory(sessionId: string): Promise<WorkingMemory> {
    await this.ensureLoaded();

    if (this.working?.sessionId === sessionId) {
      return this.working;
    }

    // Create fresh working memory for this session
    this.working = {
      sessionId,
      recentFacts: [],
      recentEpisodes: [],
      activePreferences: [],
      scratchpad: {},
      contextWindow: [],
      updatedAt: isoNow(),
    };

    return this.working;
  }

  /** Inject relevant context into working memory for a task */
  async prepareContext(sessionId: string, taskDescription: string): Promise<WorkingMemory> {
    const wm = await this.getWorkingMemory(sessionId);

    // Find relevant facts via semantic search
    const relevantFacts = await this.searchFacts({
      text: taskDescription,
      limit: 8,
      minConfidence: 0.3,
    });

    // Find similar past episodes
    const similarEpisodes = await this.findSimilarEpisodes(taskDescription, 5);

    // Get active preferences
    const prefs = await this.getAllPreferences();

    // Find relevant procedures
    const procedures = await this.findProcedure(taskDescription, 3);

    // Build context window
    const contextItems: ContextItem[] = [];

    for (const fact of relevantFacts) {
      contextItems.push({
        type: 'fact',
        content: `${fact.key}: ${JSON.stringify(fact.value)} (confidence: ${fact.confidence.toFixed(2)})`,
        relevance: fact.confidence,
        source: `semantic/${fact.category}`,
      });
    }

    for (const ep of similarEpisodes) {
      const outcomeStr = ep.outcome === 'success' ? 'succeeded' : ep.outcome === 'partial' ? 'partially succeeded' : 'failed';
      contextItems.push({
        type: 'episode',
        content: `Past task: "${ep.summary}" — ${outcomeStr} using ${ep.toolsUsed.join(', ')}${ep.lessonsLearned ? ` | Lesson: ${ep.lessonsLearned}` : ''}`,
        relevance: 0.6,
        source: `episodic/${ep.taskId}`,
      });
    }

    for (const proc of procedures) {
      contextItems.push({
        type: 'procedure',
        content: `Known procedure "${proc.name}": ${proc.description} (success rate: ${(proc.successRate * 100).toFixed(0)}%, used ${proc.timesUsed}x)`,
        relevance: proc.confidence,
        source: `procedural/${proc.id}`,
      });
    }

    for (const pref of prefs.slice(0, 5)) {
      contextItems.push({
        type: 'preference',
        content: `User prefers: ${pref.key} = ${JSON.stringify(pref.value)}`,
        relevance: pref.confidence,
        source: `preference/${pref.key}`,
      });
    }

    // Sort by relevance, take top N
    contextItems.sort((a, b) => b.relevance - a.relevance);

    wm.activeGoal = taskDescription;
    wm.recentFacts = relevantFacts;
    wm.recentEpisodes = similarEpisodes;
    wm.activePreferences = prefs;
    wm.contextWindow = contextItems.slice(0, MAX_WORKING_MEMORY_ITEMS);
    wm.updatedAt = isoNow();

    return wm;
  }

  /** Build a context injection string for the system prompt */
  buildContextInjection(wm: WorkingMemory): string {
    if (wm.contextWindow.length === 0) return '';

    const sections: string[] = ['[Agent Memory Context]'];

    const facts = wm.contextWindow.filter(c => c.type === 'fact');
    if (facts.length > 0) {
      sections.push('Known facts:');
      for (const f of facts) sections.push(`  - ${f.content}`);
    }

    const episodes = wm.contextWindow.filter(c => c.type === 'episode');
    if (episodes.length > 0) {
      sections.push('Relevant past experiences:');
      for (const e of episodes) sections.push(`  - ${e.content}`);
    }

    const procedures = wm.contextWindow.filter(c => c.type === 'procedure');
    if (procedures.length > 0) {
      sections.push('Available procedures:');
      for (const p of procedures) sections.push(`  - ${p.content}`);
    }

    const prefs = wm.contextWindow.filter(c => c.type === 'preference');
    if (prefs.length > 0) {
      sections.push('User preferences:');
      for (const p of prefs) sections.push(`  - ${p.content}`);
    }

    sections.push('[End Memory Context]');
    return sections.join('\n');
  }

  /** Set a value in working memory scratchpad */
  async setScratchpad(sessionId: string, key: string, value: unknown): Promise<void> {
    const wm = await this.getWorkingMemory(sessionId);
    wm.scratchpad[key] = value;
    wm.updatedAt = isoNow();
  }

  /** Get a value from working memory scratchpad */
  async getScratchpad(sessionId: string, key: string): Promise<unknown> {
    const wm = await this.getWorkingMemory(sessionId);
    return wm.scratchpad[key];
  }

  // ======================================================================
  // Layer 5: Associative Memory (Entity Graph)
  // ======================================================================

  async createLink(
    sourceId: string,
    sourceType: MemoryLayerType,
    targetId: string,
    targetType: MemoryLayerType,
    relationship: string,
    strength = 0.5,
  ): Promise<AssociativeLink> {
    await this.ensureLoaded();

    // Avoid duplicate links
    let existing: AssociativeLink | undefined;
    if (this.repo) {
      const sourceLinks = this.repo.getLinked(sourceId, relationship);
      const match = sourceLinks.find(l => l.targetId === targetId);
      if (match) existing = this.fromLinkData(match);
    } else {
      existing = this.links.find(
        l => l.sourceId === sourceId && l.targetId === targetId && l.relationship === relationship,
      );
    }

    if (existing) {
      existing.strength = Math.min(1, existing.strength + 0.1);
      existing.temporal.updatedAt = isoNow();

      if (this.repo) {
        this.repo.saveLink(this.toLinkData(existing));
      } else {
        this.dirtyLinks.add(existing.id);
        await this.saveLinks();
      }
      return existing;
    }

    const link: AssociativeLink = {
      id: generateId('link'),
      sourceId,
      sourceType,
      targetId,
      targetType,
      relationship,
      strength,
      temporal: createTemporal(),
    };

    if (this.repo) {
      this.repo.saveLink(this.toLinkData(link));
    } else {
      this.links.push(link);
      this.dirtyLinks.add(link.id);
      await this.saveLinks();
    }
    return link;
  }

  async getLinked(id: string, relationship?: string): Promise<AssociativeLink[]> {
    await this.ensureLoaded();

    // SQLite path — query directly
    if (this.repo) {
      const data = this.repo.getLinked(id, relationship);
      return data.map(d => this.fromLinkData(d));
    }

    // In-memory path
    return this.links.filter(l =>
      (l.sourceId === id || l.targetId === id)
      && (!relationship || l.relationship === relationship),
    );
  }

  /** Auto-create links between a new episode and related facts */
  private async autoLink(episode: EpisodicMemory): Promise<void> {
    // Get facts to link against
    const facts = this.repo
      ? this.repo.searchSemantic({ limit: 200 }).map(d => this.fromSemanticData(d))
      : this.semantics.filter(f => !f.supersededBy);

    // Find facts that share tags
    for (const tag of episode.tags) {
      const related = facts.filter(f => f.tags.includes(tag));
      for (const fact of related.slice(0, 3)) {
        await this.createLink(episode.id, 'episodic', fact.id, 'semantic', 'used_knowledge');
      }
    }

    // Link to tools used (create tool facts if they don't exist)
    for (const tool of episode.toolsUsed) {
      const toolFact = facts.find(f => f.key === `tool:${tool}`);
      if (toolFact) {
        await this.createLink(episode.id, 'episodic', toolFact.id, 'semantic', 'used_tool');
      }
    }
  }

  // ======================================================================
  // Failure Pattern Memory (Learning from Mistakes)
  // ======================================================================

  /**
   * Store or update a failure pattern. If a pattern with the same tool+error
   * signature exists, increments its occurrence count and updates lastSeen.
   */
  async storeFailurePattern(pattern: Omit<FailurePattern, 'id' | 'occurrences' | 'lastSeen'>): Promise<FailurePattern> {
    await this.ensureLoaded();

    // Find existing pattern
    let existing: FailurePattern | undefined;
    if (this.repo) {
      const allForTool = this.repo.getFailuresByTool(pattern.toolName);
      const match = allForTool.find(f => f.errorSignature === pattern.errorSignature);
      if (match) existing = this.fromFailureData(match);
    } else {
      existing = this.failures.find(
        f => f.toolName === pattern.toolName && f.errorSignature === pattern.errorSignature,
      );
    }

    if (existing) {
      existing.occurrences++;
      existing.lastSeen = isoNow();
      if (pattern.resolution && !existing.resolution) {
        existing.resolution = pattern.resolution;
      }
      if (pattern.context && pattern.context.length > existing.context.length) {
        existing.context = pattern.context;
      }

      if (this.repo) {
        this.repo.updateFailure(existing.id, existing.occurrences, existing.lastSeen, existing.resolution);
      } else {
        this.dirtyFailures.add(existing.id);
        await this.saveFailures();
      }
      return existing;
    }

    const fp: FailurePattern = {
      id: generateId('fail'),
      toolName: pattern.toolName,
      errorSignature: pattern.errorSignature,
      context: pattern.context,
      resolution: pattern.resolution,
      occurrences: 1,
      lastSeen: isoNow(),
    };

    if (this.repo) {
      this.repo.saveFailure(this.toFailureData(fp));
    } else {
      this.failures.push(fp);
      this.dirtyFailures.add(fp.id);
      await this.saveFailures();
    }
    return fp;
  }

  /** Get failure patterns, optionally filtered by tool name */
  async getFailurePatterns(toolName?: string): Promise<FailurePattern[]> {
    await this.ensureLoaded();

    // SQLite path — query directly
    if (this.repo) {
      const data = toolName ? this.repo.getFailuresByTool(toolName) : this.repo.getAllFailures();
      return data.map(d => this.fromFailureData(d));
    }

    // In-memory path
    let patterns = [...this.failures];
    if (toolName) {
      patterns = patterns.filter(f => f.toolName === toolName);
    }
    return patterns.sort((a, b) => b.occurrences - a.occurrences);
  }

  /**
   * Build a human-readable summary of failure patterns for a set of tools.
   * Used to inject into planner context for proactive avoidance.
   */
  async getFailurePatternsForPlanning(toolNames: string[]): Promise<string> {
    await this.ensureLoaded();

    let relevant: FailurePattern[];
    if (this.repo) {
      // Query SQLite per tool — more efficient than loading all
      relevant = [];
      for (const tool of toolNames) {
        const data = this.repo.getFailuresByTool(tool);
        relevant.push(...data.map(d => this.fromFailureData(d)));
      }
    } else {
      relevant = this.failures.filter(f => toolNames.includes(f.toolName));
    }

    if (relevant.length === 0) return '';

    return relevant
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, 10)
      .map(f => {
        let line = `- ${f.toolName}: "${f.errorSignature}" (${f.occurrences}x)`;
        if (f.resolution) line += ` → resolved: ${f.resolution}`;
        return line;
      })
      .join('\n');
  }

  private saveFailures() {
    if (this.repo) {
      if (!this.batchMode) this.persistDirtyFailures();
      return Promise.resolve();
    }
    return this.writeJson('failures.json', this.failures);
  }

  // ======================================================================
  // Preferences (Sub-layer of Semantic)
  // ======================================================================

  async setPreference(
    key: string,
    value: unknown,
    learnedFrom: string,
    scope: MemoryScope = 'user',
    scopeId?: string,
  ): Promise<PreferenceMemory> {
    await this.ensureLoaded();

    let existing: PreferenceMemory | undefined;
    if (this.repo) {
      const data = this.repo.getPreference(key);
      if (data && (data.scope === scope)) existing = this.fromPreferenceData(data);
    } else {
      existing = this.preferences.find(p => p.key === key && p.scope === scope);
    }

    if (existing) {
      existing.value = value;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.learnedFrom = learnedFrom;
      existing.temporal.updatedAt = isoNow();

      if (this.repo) {
        this.repo.savePreference(this.toPreferenceData(existing));
      } else {
        this.dirtyPreferences.add(existing.id);
        await this.savePreferences();
      }
      return existing;
    }

    const pref: PreferenceMemory = {
      id: generateId('pref'),
      key,
      value,
      learnedFrom,
      confidence: 0.5,
      scope,
      scopeId,
      temporal: createTemporal(),
    };

    if (this.repo) {
      this.repo.savePreference(this.toPreferenceData(pref));
    } else {
      this.preferences.push(pref);
      this.dirtyPreferences.add(pref.id);
      await this.savePreferences();
    }
    return pref;
  }

  async getPreference(key: string): Promise<PreferenceMemory | undefined> {
    await this.ensureLoaded();

    // SQLite path
    if (this.repo) {
      const data = this.repo.getPreference(key);
      return data ? this.fromPreferenceData(data) : undefined;
    }

    return this.preferences.find(p => p.key === key);
  }

  async getAllPreferences(scope?: MemoryScope): Promise<PreferenceMemory[]> {
    await this.ensureLoaded();

    // SQLite path — query directly
    if (this.repo) {
      const data = this.repo.getAllPreferences(scope);
      return data.map(d => this.fromPreferenceData(d));
    }

    // In-memory path
    let prefs = [...this.preferences];
    if (scope) prefs = prefs.filter(p => p.scope === scope);
    return prefs.sort((a, b) => b.confidence - a.confidence);
  }

  // ======================================================================
  // Cross-Layer Search
  // ======================================================================

  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();
    const results: MemorySearchResult[] = [];

    if (!query.layer || query.layer === 'semantic') {
      const facts = await this.searchFacts(query);
      if (facts.length > 0) {
        results.push({ layer: 'semantic', items: facts, totalCount: facts.length });
      }
    }

    if (!query.layer || query.layer === 'episodic') {
      const episodes = await this.searchEpisodes(query);
      if (episodes.length > 0) {
        results.push({ layer: 'episodic', items: episodes, totalCount: episodes.length });
      }
    }

    if (!query.layer || query.layer === 'procedural') {
      let procs: ProceduralMemory[];
      if (query.text) {
        procs = await this.findProcedure(query.text, query.limit ?? 10);
      } else {
        procs = this.repo
          ? this.repo.getAllProcedural().map(d => this.fromProceduralData(d))
          : [...this.procedures];
      }
      if (procs.length > 0) {
        results.push({ layer: 'procedural', items: procs, totalCount: procs.length });
      }
    }

    if (!query.layer || query.layer === 'preference') {
      const prefs = await this.getAllPreferences(query.scope);
      const filtered = query.minConfidence
        ? prefs.filter(p => p.confidence >= query.minConfidence!)
        : prefs;
      if (filtered.length > 0) {
        results.push({
          layer: 'preference',
          items: filtered.slice(0, query.limit ?? 20),
          totalCount: filtered.length,
        });
      }
    }

    return results;
  }

  // ======================================================================
  // Memory Consolidation (Background Maintenance)
  // ======================================================================

  async consolidate(): Promise<MemoryConsolidationResult> {
    await this.ensureLoaded();
    let merged = 0;
    let pruned = 0;
    let decayed = 0;
    let promoted = 0;

    if (this.repo) {
      // ═══ SQLite consolidation — use targeted SQL operations ═══
      this.repo.transaction(() => {
        // 1. Confidence decay — load all active facts, apply decay, write back changed ones
        const allFacts = this.repo!.getAllSemantic().map(d => this.fromSemanticData(d));
        for (const fact of allFacts) {
          const days = daysSince(fact.temporal.lastAccessedAt);
          if (days > 1) {
            const decay = CONFIDENCE_DECAY_RATE * days;
            const newConfidence = Math.max(0.05, fact.confidence - decay);
            if (newConfidence < fact.confidence) {
              this.repo!.updateSemanticConfidence(fact.id, newConfidence);
              decayed++;
            }
          }
        }

        // 2. Merge duplicate facts
        const factsByKey = new Map<string, SemanticMemory[]>();
        for (const f of allFacts) {
          const k = `${f.scope}:${f.scopeId ?? ''}:${f.key}`;
          const arr = factsByKey.get(k) ?? [];
          arr.push(f);
          factsByKey.set(k, arr);
        }
        for (const [, facts] of factsByKey) {
          if (facts.length <= 1) continue;
          facts.sort((a, b) => b.confidence - a.confidence);
          for (let i = 1; i < facts.length; i++) {
            this.repo!.supersedeSemantic(facts[i].id, facts[0].id);
            merged++;
          }
        }

        // 3. Prune old low-confidence facts
        pruned += this.repo!.deleteSemanticBelow(0.1, 90);

        // 4. Prune old episodes (keep last 500)
        pruned += this.repo!.pruneEpisodic(500);

        // 5. Prune orphan links
        pruned += this.repo!.pruneOrphanLinks();
      });

      return { merged, pruned, decayed, promoted };
    }

    // ═══ JSON file consolidation (original behavior) ═══

    // 1. Confidence decay
    for (const fact of this.semantics) {
      if (fact.supersededBy) continue;
      const days = daysSince(fact.temporal.lastAccessedAt);
      if (days > 1) {
        const decay = CONFIDENCE_DECAY_RATE * days;
        const newConfidence = Math.max(0.05, fact.confidence - decay);
        if (newConfidence < fact.confidence) {
          fact.confidence = newConfidence;
          decayed++;
        }
      }
    }

    // 2. Merge duplicate facts
    const factsByKey = new Map<string, SemanticMemory[]>();
    for (const f of this.semantics.filter(f => !f.supersededBy)) {
      const k = `${f.scope}:${f.scopeId ?? ''}:${f.key}`;
      const arr = factsByKey.get(k) ?? [];
      arr.push(f);
      factsByKey.set(k, arr);
    }
    for (const [, facts] of factsByKey) {
      if (facts.length <= 1) continue;
      facts.sort((a, b) => b.confidence - a.confidence);
      for (let i = 1; i < facts.length; i++) {
        facts[i].supersededBy = facts[0].id;
        merged++;
      }
    }

    // 3. Prune old low-confidence items
    const cutoff90Days = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const beforeSemantics = this.semantics.length;
    this.semantics = this.semantics.filter(f =>
      f.confidence > 0.1 || f.temporal.updatedAt >= cutoff90Days,
    );
    pruned += beforeSemantics - this.semantics.length;

    // Prune old episodes (keep last 500)
    if (this.episodes.length > 500) {
      this.episodes.sort((a, b) => b.temporal.createdAt.localeCompare(a.temporal.createdAt));
      pruned += this.episodes.length - 500;
      this.episodes = this.episodes.slice(0, 500);
    }

    // 4. Prune stale links
    const validIds = new Set([
      ...this.semantics.map(s => s.id),
      ...this.episodes.map(e => e.id),
      ...this.procedures.map(p => p.id),
      ...this.preferences.map(p => p.id),
    ]);
    const beforeLinks = this.links.length;
    this.links = this.links.filter(l => validIds.has(l.sourceId) && validIds.has(l.targetId));
    pruned += beforeLinks - this.links.length;

    // 5. Promote frequent scratchpad items to long-term facts
    if (this.working) {
      for (const [key, value] of Object.entries(this.working.scratchpad)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          const existingFact = this.semantics.find(f => f.key === `scratch:${key}` && !f.supersededBy);
          if (existingFact && existingFact.temporal.accessCount >= 3) {
            existingFact.key = key;
            existingFact.category = 'promoted';
            existingFact.confidence = Math.min(1, existingFact.confidence + 0.2);
            promoted++;
          }
        }
      }
    }

    // Rebuild index maps
    this.semanticMap.clear();
    for (const s of this.semantics) this.semanticMap.set(s.id, s);
    this.episodeMap.clear();
    for (const e of this.episodes) this.episodeMap.set(e.id, e);

    // Rebuild search indices after pruning
    this.semanticIndex.clear();
    for (const s of this.semantics) {
      this.semanticIndex.add(s.id, this.semanticToText(s));
    }
    this.episodeIndex.clear();
    for (const e of this.episodes) {
      this.episodeIndex.add(e.id, this.episodeToText(e));
    }

    // Save all layers
    await Promise.all([
      this.writeJson('semantics.json', this.semantics),
      this.writeJson('episodes.json', this.episodes),
      this.writeJson('procedures.json', this.procedures),
      this.writeJson('preferences.json', this.preferences),
      this.writeJson('links.json', this.links),
    ]);

    return { merged, pruned, decayed, promoted };
  }

  // ======================================================================
  // Stats
  // ======================================================================

  async getStats(): Promise<MemoryStats> {
    await this.ensureLoaded();

    // SQLite path — use repo counts
    if (this.repo) {
      const counts = this.repo.counts();
      return {
        totalFacts: counts.semantic,
        totalEpisodes: counts.episodic,
        totalProcedures: counts.procedural,
        totalPreferences: counts.preferences,
        totalLinks: counts.links,
        avgFactConfidence: 0,
        avgEpisodeSuccess: 0,
        oldestMemory: '',
        newestMemory: '',
        storageBytes: 0,
      };
    }

    // In-memory path
    const allDates = [
      ...this.semantics.map(s => s.temporal.createdAt),
      ...this.episodes.map(e => e.temporal.createdAt),
    ];

    const successEps = this.episodes.filter(e => e.outcome === 'success');

    return {
      totalFacts: this.semantics.filter(f => !f.supersededBy).length,
      totalEpisodes: this.episodes.length,
      totalProcedures: this.procedures.length,
      totalPreferences: this.preferences.length,
      totalLinks: this.links.length,
      avgFactConfidence: this.semantics.length > 0
        ? this.semantics.filter(f => !f.supersededBy).reduce((s, f) => s + f.confidence, 0) / this.semantics.filter(f => !f.supersededBy).length
        : 0,
      avgEpisodeSuccess: this.episodes.length > 0
        ? successEps.length / this.episodes.length
        : 0,
      oldestMemory: allDates.length > 0 ? allDates.sort()[0] : '',
      newestMemory: allDates.length > 0 ? allDates.sort().reverse()[0] : '',
      storageBytes: 0, // calculated on demand
    };
  }

  // ======================================================================
  // Helpers
  // ======================================================================

  private semanticToText(s: SemanticMemory): string {
    return `${s.key} ${s.category} ${String(s.value)} ${s.tags.join(' ')}`;
  }

  private episodeToText(e: EpisodicMemory): string {
    return `${e.summary} ${e.toolsUsed.join(' ')} ${e.tags.join(' ')} ${e.context ?? ''} ${e.lessonsLearned ?? ''}`;
  }

  // ======================================================================
  // SQLite ↔ Domain Conversion
  // ======================================================================

  private toSemanticData(s: SemanticMemory): SemanticData {
    return {
      id: s.id, key: s.key, value: s.value, category: s.category,
      source: s.source, confidence: s.confidence, scope: s.scope,
      scopeId: s.scopeId, tags: s.tags,
      supersedes: s.supersedes, supersededBy: s.supersededBy,
      createdAt: s.temporal.createdAt, updatedAt: s.temporal.updatedAt,
      lastAccessedAt: s.temporal.lastAccessedAt, accessCount: s.temporal.accessCount,
    };
  }

  private fromSemanticData(d: SemanticData): SemanticMemory {
    return {
      id: d.id, key: d.key, value: d.value, category: d.category,
      source: d.source, confidence: d.confidence,
      scope: d.scope as MemoryScope, scopeId: d.scopeId,
      tags: d.tags, supersedes: d.supersedes, supersededBy: d.supersededBy,
      temporal: {
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        lastAccessedAt: d.lastAccessedAt, accessCount: d.accessCount,
      },
    };
  }

  private toEpisodicData(e: EpisodicMemory): EpisodicData {
    return {
      id: e.id, taskId: e.taskId, summary: e.summary, outcome: e.outcome,
      toolsUsed: e.toolsUsed, stepsCompleted: e.stepsCompleted,
      totalSteps: e.totalSteps, energyUsed: e.energyUsed,
      carbonUsed: e.carbonUsed, costUsd: e.costUsd, durationMs: e.durationMs,
      scope: e.scope, scopeId: e.scopeId,
      context: e.context, lessonsLearned: e.lessonsLearned, tags: e.tags,
      createdAt: e.temporal.createdAt, updatedAt: e.temporal.updatedAt,
      lastAccessedAt: e.temporal.lastAccessedAt, accessCount: e.temporal.accessCount,
    };
  }

  private fromEpisodicData(d: EpisodicData): EpisodicMemory {
    return {
      id: d.id, taskId: d.taskId, summary: d.summary,
      outcome: d.outcome as EpisodicMemory['outcome'],
      toolsUsed: d.toolsUsed, stepsCompleted: d.stepsCompleted,
      totalSteps: d.totalSteps, energyUsed: d.energyUsed,
      carbonUsed: d.carbonUsed, costUsd: d.costUsd, durationMs: d.durationMs,
      scope: d.scope as MemoryScope, scopeId: d.scopeId,
      context: d.context, lessonsLearned: d.lessonsLearned, tags: d.tags,
      temporal: {
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        lastAccessedAt: d.lastAccessedAt, accessCount: d.accessCount,
      },
    };
  }

  private toProceduralData(p: ProceduralMemory): ProceduralData {
    return {
      id: p.id, name: p.name, description: p.description,
      pattern: p.pattern, confidence: p.confidence,
      successRate: p.successRate, timesUsed: p.timesUsed,
      scope: p.scope, scopeId: p.scopeId, tags: p.tags,
      createdAt: p.temporal.createdAt, updatedAt: p.temporal.updatedAt,
      lastAccessedAt: p.temporal.lastAccessedAt, accessCount: p.temporal.accessCount,
    };
  }

  private fromProceduralData(d: ProceduralData): ProceduralMemory {
    return {
      id: d.id, name: d.name, description: d.description,
      pattern: d.pattern as ProceduralMemory['pattern'],
      confidence: d.confidence, successRate: d.successRate,
      timesUsed: d.timesUsed,
      scope: d.scope as MemoryScope, scopeId: d.scopeId, tags: d.tags,
      temporal: {
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        lastAccessedAt: d.lastAccessedAt, accessCount: d.accessCount,
      },
    };
  }

  private toPreferenceData(p: PreferenceMemory): PreferenceData {
    return {
      id: p.id, key: p.key, value: p.value,
      learnedFrom: p.learnedFrom, confidence: p.confidence,
      scope: p.scope, scopeId: p.scopeId,
      createdAt: p.temporal.createdAt, updatedAt: p.temporal.updatedAt,
      lastAccessedAt: p.temporal.lastAccessedAt, accessCount: p.temporal.accessCount,
    };
  }

  private fromPreferenceData(d: PreferenceData): PreferenceMemory {
    return {
      id: d.id, key: d.key, value: d.value,
      learnedFrom: d.learnedFrom, confidence: d.confidence,
      scope: d.scope as MemoryScope, scopeId: d.scopeId,
      temporal: {
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        lastAccessedAt: d.lastAccessedAt, accessCount: d.accessCount,
      },
    };
  }

  private toLinkData(l: AssociativeLink): LinkData {
    return {
      id: l.id, sourceId: l.sourceId, sourceType: l.sourceType,
      targetId: l.targetId, targetType: l.targetType,
      relationship: l.relationship, strength: l.strength,
      createdAt: l.temporal.createdAt, updatedAt: l.temporal.updatedAt,
      lastAccessedAt: l.temporal.lastAccessedAt, accessCount: l.temporal.accessCount,
    };
  }

  private fromLinkData(d: LinkData): AssociativeLink {
    return {
      id: d.id, sourceId: d.sourceId, sourceType: d.sourceType as MemoryLayerType,
      targetId: d.targetId, targetType: d.targetType as MemoryLayerType,
      relationship: d.relationship, strength: d.strength,
      temporal: {
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        lastAccessedAt: d.lastAccessedAt, accessCount: d.accessCount,
      },
    };
  }

  private toFailureData(f: FailurePattern): FailureData {
    return {
      id: f.id, toolName: f.toolName, errorSignature: f.errorSignature,
      context: f.context, resolution: f.resolution,
      occurrences: f.occurrences, lastSeen: f.lastSeen,
    };
  }

  private fromFailureData(d: FailureData): FailurePattern {
    return {
      id: d.id, toolName: d.toolName, errorSignature: d.errorSignature,
      context: d.context, resolution: d.resolution,
      occurrences: d.occurrences, lastSeen: d.lastSeen,
    };
  }

  private async readJson<T>(filename: string, fallback: T): Promise<T> {
    try {
      const content = await fs.readFile(path.join(this.memoryDir, filename), 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(filename: string, data: unknown): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(path.join(this.memoryDir, filename), JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── Dirty-aware persist helpers (used by saveX and flushDirty) ──

  private persistDirtySemantics(): void {
    if (!this.repo) return;
    for (const id of this.dirtySemantics) {
      const item = this.semanticMap.get(id);
      if (item) this.repo.saveSemantic(this.toSemanticData(item));
    }
    this.dirtySemantics.clear();
  }

  private persistDirtyEpisodes(): void {
    if (!this.repo) return;
    for (const id of this.dirtyEpisodes) {
      const item = this.episodeMap.get(id);
      if (item) this.repo.saveEpisodic(this.toEpisodicData(item));
    }
    this.dirtyEpisodes.clear();
  }

  private persistDirtyProcedures(): void {
    if (!this.repo) return;
    for (const id of this.dirtyProcedures) {
      const item = this.procedures.find(p => p.id === id);
      if (item) this.repo.saveProcedural(this.toProceduralData(item));
    }
    this.dirtyProcedures.clear();
  }

  private persistDirtyPreferences(): void {
    if (!this.repo) return;
    for (const id of this.dirtyPreferences) {
      const item = this.preferences.find(p => p.id === id);
      if (item) this.repo.savePreference(this.toPreferenceData(item));
    }
    this.dirtyPreferences.clear();
  }

  private persistDirtyLinks(): void {
    if (!this.repo) return;
    for (const id of this.dirtyLinks) {
      const item = this.links.find(l => l.id === id);
      if (item) this.repo.saveLink(this.toLinkData(item));
    }
    this.dirtyLinks.clear();
  }

  private persistDirtyFailures(): void {
    if (!this.repo) return;
    for (const id of this.dirtyFailures) {
      const item = this.failures.find(f => f.id === id);
      if (item) this.repo.saveFailure(this.toFailureData(item));
    }
    this.dirtyFailures.clear();
  }

  // ── Save methods (batch-aware) ──

  private saveSemantics() {
    if (this.repo) {
      if (!this.batchMode) this.persistDirtySemantics();
      return Promise.resolve();
    }
    return this.writeJson('semantics.json', this.semantics);
  }
  private saveEpisodes() {
    if (this.repo) {
      if (!this.batchMode) this.persistDirtyEpisodes();
      return Promise.resolve();
    }
    return this.writeJson('episodes.json', this.episodes);
  }
  private saveProcedures() {
    if (this.repo) {
      if (!this.batchMode) this.persistDirtyProcedures();
      return Promise.resolve();
    }
    return this.writeJson('procedures.json', this.procedures);
  }
  private savePreferences() {
    if (this.repo) {
      if (!this.batchMode) this.persistDirtyPreferences();
      return Promise.resolve();
    }
    return this.writeJson('preferences.json', this.preferences);
  }
  private saveLinks() {
    if (this.repo) {
      if (!this.batchMode) this.persistDirtyLinks();
      return Promise.resolve();
    }
    return this.writeJson('links.json', this.links);
  }
}
