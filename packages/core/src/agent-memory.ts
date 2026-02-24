/**
 * AgentMemory — Backward-Compatible Wrapper over OptimizedMemory
 *
 * Maintains the original AgentMemory API for existing code while
 * delegating to the new 5-layer OptimizedMemory system underneath.
 */

import {
  type MemoryEpisode,
  type MemoryPreference,
  type MemoryQuery,
  type MemorySearchResult,
  type SemanticMemory,
  type MemoryLayerType,
} from '@joule/shared';
import type { MemoryRepository } from '@joule/store';
import { OptimizedMemory } from './memory/optimized-memory.js';

// Map new layer names back to legacy names for backward compat
const LAYER_TO_LEGACY: Record<string, string> = {
  semantic: 'facts',
  episodic: 'episodes',
  preference: 'preferences',
  procedural: 'procedural',
  working: 'working',
  associative: 'associative',
};

export class AgentMemory {
  readonly optimized: OptimizedMemory;

  constructor(baseDir?: string, memoryRepo?: MemoryRepository) {
    this.optimized = new OptimizedMemory(baseDir, memoryRepo);
  }

  // --- Facts Layer (delegates to semantic memory) ---

  async storeFact(key: string, value: unknown, category: string, source: string): Promise<SemanticMemory> {
    return this.optimized.storeFact(key, value, category, source);
  }

  async getFact(key: string): Promise<SemanticMemory | undefined> {
    return this.optimized.getFact(key);
  }

  async searchFacts(query: MemoryQuery): Promise<SemanticMemory[]> {
    return this.optimized.searchFacts(query);
  }

  async updateFactConfidence(id: string, delta: number): Promise<void> {
    // Access internal facts directly via search, then update in place
    const facts = await this.optimized.searchFacts({ limit: 1000, includeExpired: true });
    const fact = facts.find(f => f.id === id);
    if (fact) {
      // Directly update the confidence via store (same key + same value = boost)
      // We need to first update, then manually adjust
      const newConf = Math.max(0, Math.min(1, fact.confidence + delta));
      // Store with same value will boost confidence by 0.1, but we need `delta`
      // So we store and then manually adjust the difference
      fact.confidence = newConf;
      fact.temporal.updatedAt = new Date().toISOString();
    }
  }

  // --- Episodes Layer ---

  async recordEpisode(
    taskId: string,
    summary: string,
    outcome: MemoryEpisode['outcome'],
    toolsUsed: string[],
    energyUsed: number,
    carbonUsed: number,
    tags: string[] = [],
  ): Promise<MemoryEpisode> {
    const ep = await this.optimized.recordEpisode(taskId, summary, outcome, toolsUsed, {
      energyUsed,
      carbonUsed,
      tags,
    });
    return {
      id: ep.id,
      taskId: ep.taskId,
      summary: ep.summary,
      outcome: ep.outcome,
      toolsUsed: ep.toolsUsed,
      energyUsed: ep.energyUsed,
      carbonUsed: ep.carbonUsed,
      timestamp: ep.temporal.createdAt,
      tags: ep.tags,
    };
  }

  async getRecentEpisodes(limit = 10): Promise<MemoryEpisode[]> {
    const eps = await this.optimized.getRecentEpisodes(limit);
    return eps.map(ep => ({
      id: ep.id,
      taskId: ep.taskId,
      summary: ep.summary,
      outcome: ep.outcome,
      toolsUsed: ep.toolsUsed,
      energyUsed: ep.energyUsed,
      carbonUsed: ep.carbonUsed,
      timestamp: ep.temporal.createdAt,
      tags: ep.tags,
    }));
  }

  async searchEpisodes(tags: string[]): Promise<MemoryEpisode[]> {
    const eps = await this.optimized.searchEpisodes({ tags });
    return eps.map(ep => ({
      id: ep.id,
      taskId: ep.taskId,
      summary: ep.summary,
      outcome: ep.outcome,
      toolsUsed: ep.toolsUsed,
      energyUsed: ep.energyUsed,
      carbonUsed: ep.carbonUsed,
      timestamp: ep.temporal.createdAt,
      tags: ep.tags,
    }));
  }

  // --- Preferences Layer ---

  async setPreference(key: string, value: unknown, learnedFrom: string): Promise<MemoryPreference> {
    const pref = await this.optimized.setPreference(key, value, learnedFrom);
    return {
      id: pref.id,
      key: pref.key,
      value: pref.value,
      learnedFrom: pref.learnedFrom,
      confidence: pref.confidence,
      createdAt: pref.temporal.createdAt,
    };
  }

  async getPreference(key: string): Promise<MemoryPreference | undefined> {
    const pref = await this.optimized.getPreference(key);
    if (!pref) return undefined;
    return {
      id: pref.id,
      key: pref.key,
      value: pref.value,
      learnedFrom: pref.learnedFrom,
      confidence: pref.confidence,
      createdAt: pref.temporal.createdAt,
    };
  }

  async getAllPreferences(): Promise<MemoryPreference[]> {
    const prefs = await this.optimized.getAllPreferences();
    return prefs.map(p => ({
      id: p.id,
      key: p.key,
      value: p.value,
      learnedFrom: p.learnedFrom,
      confidence: p.confidence,
      createdAt: p.temporal.createdAt,
    }));
  }

  // --- Cross-layer recall (backward compatible) ---

  async recall(query: MemoryQuery): Promise<MemorySearchResult[]> {
    // Map old layer names to new ones for the query
    const mapped: MemoryQuery = { ...query };
    if (query.layer === 'facts' as any) mapped.layer = 'semantic';
    if (query.layer === 'episodes' as any) mapped.layer = 'episodic';
    if (query.layer === 'preferences' as any) mapped.layer = 'preference';

    const results = await this.optimized.recall(mapped);

    // Map new layer names back to legacy names in results
    return results.map(r => ({
      ...r,
      layer: (LAYER_TO_LEGACY[r.layer] ?? r.layer) as MemoryLayerType,
    }));
  }

  // --- Maintenance ---

  async prune(maxAge?: number, maxItems?: number): Promise<{ factsRemoved: number; episodesRemoved: number }> {
    // If maxItems requested, handle directly
    if (maxItems !== undefined) {
      const allFacts = await this.optimized.searchFacts({ limit: 10000 });
      const allEpisodes = await this.optimized.getRecentEpisodes(10000);
      let factsRemoved = 0;
      let episodesRemoved = 0;

      if (allFacts.length > maxItems) {
        factsRemoved = allFacts.length - maxItems;
      }
      if (allEpisodes.length > maxItems) {
        episodesRemoved = allEpisodes.length - maxItems;
      }

      // Run consolidation for actual cleanup
      await this.optimized.consolidate();

      return { factsRemoved, episodesRemoved };
    }

    const result = await this.optimized.consolidate();
    return {
      factsRemoved: result.pruned,
      episodesRemoved: result.pruned,
    };
  }
}
