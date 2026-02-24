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
      // Load from SQLite
      this.semantics = this.repo.getAllSemantic({ includeSuperseded: true }).map(d => this.fromSemanticData(d));
      this.episodes = this.repo.getAllEpisodic().map(d => this.fromEpisodicData(d));
      this.procedures = this.repo.getAllProcedural().map(d => this.fromProceduralData(d));
      this.preferences = this.repo.getAllPreferences().map(d => this.fromPreferenceData(d));
      this.links = this.repo.getAllLinks().map(d => this.fromLinkData(d));
      this.failures = this.repo.getAllFailures().map(d => this.fromFailureData(d));
    } else {
      // Load from JSON files
      await this.ensureDir();
      this.semantics = await this.readJson<SemanticMemory[]>('semantics.json', []);
      this.episodes = await this.readJson<EpisodicMemory[]>('episodes.json', []);
      this.procedures = await this.readJson<ProceduralMemory[]>('procedures.json', []);
      this.preferences = await this.readJson<PreferenceMemory[]>('preferences.json', []);
      this.links = await this.readJson<AssociativeLink[]>('links.json', []);
      this.failures = await this.readJson<FailurePattern[]>('failures.json', []);
    }

    // Rebuild search indices
    for (const s of this.semantics) {
      this.semanticIndex.add(s.id, this.semanticToText(s));
    }
    for (const e of this.episodes) {
      this.episodeIndex.add(e.id, this.episodeToText(e));
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

    // Check for existing fact with same key + scope
    const existing = this.semantics.find(
      f => f.key === key && f.scope === scope && f.scopeId === scopeId && !f.supersededBy,
    );

    if (existing) {
      // Update existing — boost confidence
      const oldValue = JSON.stringify(existing.value);
      const newValue = JSON.stringify(value);

      if (oldValue !== newValue) {
        // Value changed — create new fact superseding old one
        existing.supersededBy = generateId('fact');
        existing.temporal.updatedAt = isoNow();

        const newFact: SemanticMemory = {
          id: existing.supersededBy,
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

        this.semantics.push(newFact);
        this.semanticIndex.add(newFact.id, this.semanticToText(newFact));
        await this.saveSemantics();
        return newFact;
      }

      // Same value — just boost confidence
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.temporal.updatedAt = isoNow();
      existing.temporal.accessCount++;
      existing.tags = [...new Set([...existing.tags, ...tags])];
      this.semanticIndex.update(existing.id, this.semanticToText(existing));
      await this.saveSemantics();
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

    this.semantics.push(fact);
    this.semanticIndex.add(fact.id, this.semanticToText(fact));
    await this.saveSemantics();
    return fact;
  }

  async getFact(key: string, scope?: MemoryScope, scopeId?: string): Promise<SemanticMemory | undefined> {
    await this.ensureLoaded();
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

    this.episodes.push(episode);
    this.episodeIndex.add(episode.id, this.episodeToText(episode));

    // Auto-create associative links to related facts
    await this.autoLink(episode);

    await this.saveEpisodes();
    return episode;
  }

  async getRecentEpisodes(limit = 10, scope?: MemoryScope): Promise<EpisodicMemory[]> {
    await this.ensureLoaded();
    let eps = [...this.episodes];
    if (scope) eps = eps.filter(e => e.scope === scope);
    return eps
      .sort((a, b) => b.temporal.createdAt.localeCompare(a.temporal.createdAt))
      .slice(0, limit);
  }

  async searchEpisodes(query: MemoryQuery): Promise<EpisodicMemory[]> {
    await this.ensureLoaded();
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
    const existing = this.procedures.find(p => p.name === name && p.scope === scope);
    if (existing) {
      existing.pattern.steps = steps;
      existing.pattern.trigger = trigger;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.temporal.updatedAt = isoNow();
      await this.saveProcedures();
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

    this.procedures.push(proc);
    await this.saveProcedures();
    return proc;
  }

  async findProcedure(taskDescription: string, limit = 3): Promise<ProceduralMemory[]> {
    await this.ensureLoaded();
    // Simple keyword matching against trigger patterns
    const words = taskDescription.toLowerCase().split(/\s+/);
    return this.procedures
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
    const proc = this.procedures.find(p => p.id === id);
    if (!proc) return;

    proc.timesUsed++;
    proc.successRate = ((proc.successRate * (proc.timesUsed - 1)) + (success ? 1 : 0)) / proc.timesUsed;
    proc.confidence = Math.min(1, proc.confidence + (success ? 0.05 : -0.1));
    proc.temporal.updatedAt = isoNow();
    proc.temporal.lastAccessedAt = isoNow();
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
    const existing = this.links.find(
      l => l.sourceId === sourceId && l.targetId === targetId && l.relationship === relationship,
    );
    if (existing) {
      existing.strength = Math.min(1, existing.strength + 0.1);
      existing.temporal.updatedAt = isoNow();
      await this.saveLinks();
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

    this.links.push(link);
    await this.saveLinks();
    return link;
  }

  async getLinked(id: string, relationship?: string): Promise<AssociativeLink[]> {
    await this.ensureLoaded();
    return this.links.filter(l =>
      (l.sourceId === id || l.targetId === id)
      && (!relationship || l.relationship === relationship),
    );
  }

  /** Auto-create links between a new episode and related facts */
  private async autoLink(episode: EpisodicMemory): Promise<void> {
    // Find facts that share tags
    for (const tag of episode.tags) {
      const related = this.semantics.filter(f => f.tags.includes(tag) && !f.supersededBy);
      for (const fact of related.slice(0, 3)) {
        await this.createLink(episode.id, 'episodic', fact.id, 'semantic', 'used_knowledge');
      }
    }

    // Link to tools used (create tool facts if they don't exist)
    for (const tool of episode.toolsUsed) {
      const toolFact = this.semantics.find(f => f.key === `tool:${tool}` && !f.supersededBy);
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

    const existing = this.failures.find(
      f => f.toolName === pattern.toolName && f.errorSignature === pattern.errorSignature,
    );

    if (existing) {
      existing.occurrences++;
      existing.lastSeen = isoNow();
      if (pattern.resolution && !existing.resolution) {
        existing.resolution = pattern.resolution;
      }
      if (pattern.context && pattern.context.length > existing.context.length) {
        existing.context = pattern.context;
      }
      await this.saveFailures();
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

    this.failures.push(fp);
    await this.saveFailures();
    return fp;
  }

  /** Get failure patterns, optionally filtered by tool name */
  async getFailurePatterns(toolName?: string): Promise<FailurePattern[]> {
    await this.ensureLoaded();
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
    const relevant = this.failures.filter(f => toolNames.includes(f.toolName));
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
      for (const f of this.failures) this.repo.saveFailure(this.toFailureData(f));
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

    const existing = this.preferences.find(p => p.key === key && p.scope === scope);
    if (existing) {
      existing.value = value;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.learnedFrom = learnedFrom;
      existing.temporal.updatedAt = isoNow();
      await this.savePreferences();
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

    this.preferences.push(pref);
    await this.savePreferences();
    return pref;
  }

  async getPreference(key: string): Promise<PreferenceMemory | undefined> {
    await this.ensureLoaded();
    return this.preferences.find(p => p.key === key);
  }

  async getAllPreferences(scope?: MemoryScope): Promise<PreferenceMemory[]> {
    await this.ensureLoaded();
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
      let procs = [...this.procedures];
      if (query.text) {
        procs = await this.findProcedure(query.text, query.limit ?? 10);
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

    // 1. Confidence decay — facts lose confidence over time if not accessed
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

    // 2. Merge duplicate facts — same key, same scope, different values
    const factsByKey = new Map<string, SemanticMemory[]>();
    for (const f of this.semantics.filter(f => !f.supersededBy)) {
      const k = `${f.scope}:${f.scopeId ?? ''}:${f.key}`;
      const arr = factsByKey.get(k) ?? [];
      arr.push(f);
      factsByKey.set(k, arr);
    }
    for (const [, facts] of factsByKey) {
      if (facts.length <= 1) continue;
      // Keep highest confidence, supersede others
      facts.sort((a, b) => b.confidence - a.confidence);
      for (let i = 1; i < facts.length; i++) {
        facts[i].supersededBy = facts[0].id;
        merged++;
      }
    }

    // 3. Prune very old, low-confidence items
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
          // Check if this was stored multiple sessions
          const existingFact = this.semantics.find(f => f.key === `scratch:${key}` && !f.supersededBy);
          if (existingFact && existingFact.temporal.accessCount >= 3) {
            // Promote to permanent fact
            existingFact.key = key;
            existingFact.category = 'promoted';
            existingFact.confidence = Math.min(1, existingFact.confidence + 0.2);
            promoted++;
          }
        }
      }
    }

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
      this.saveSemantics(),
      this.saveEpisodes(),
      this.saveProcedures(),
      this.savePreferences(),
      this.saveLinks(),
    ]);

    return { merged, pruned, decayed, promoted };
  }

  // ======================================================================
  // Stats
  // ======================================================================

  async getStats(): Promise<MemoryStats> {
    await this.ensureLoaded();

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

  private saveSemantics() {
    if (this.repo) {
      for (const s of this.semantics) this.repo.saveSemantic(this.toSemanticData(s));
      return Promise.resolve();
    }
    return this.writeJson('semantics.json', this.semantics);
  }
  private saveEpisodes() {
    if (this.repo) {
      for (const e of this.episodes) this.repo.saveEpisodic(this.toEpisodicData(e));
      return Promise.resolve();
    }
    return this.writeJson('episodes.json', this.episodes);
  }
  private saveProcedures() {
    if (this.repo) {
      for (const p of this.procedures) this.repo.saveProcedural(this.toProceduralData(p));
      return Promise.resolve();
    }
    return this.writeJson('procedures.json', this.procedures);
  }
  private savePreferences() {
    if (this.repo) {
      for (const p of this.preferences) this.repo.savePreference(this.toPreferenceData(p));
      return Promise.resolve();
    }
    return this.writeJson('preferences.json', this.preferences);
  }
  private saveLinks() {
    if (this.repo) {
      for (const l of this.links) this.repo.saveLink(this.toLinkData(l));
      return Promise.resolve();
    }
    return this.writeJson('links.json', this.links);
  }
}
