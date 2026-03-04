/**
 * LongTermMemory — Cross-session learning from task outcomes.
 *
 * Builds on OptimizedMemory's episodic + procedural layers to provide:
 *  - Outcome recording with automatic lesson extraction
 *  - Tool effectiveness tracking (which tools work best for which task types)
 *  - Success/failure pattern detection
 *  - Contextual recall of relevant past experiences for new tasks
 *
 * This is what makes Joule genuinely learn across runs — not just store history,
 * but derive actionable insights that improve future decisions.
 */

import type { MemoryEpisode } from '@joule/shared';
import type { AgentMemory } from './agent-memory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TaskOutcome {
  taskId: string;
  taskType: string;           // e.g. 'code-review', 'bug-fix', 'research'
  description: string;
  outcome: 'success' | 'partial' | 'failed';
  toolsUsed: string[];
  modelUsed?: string;
  durationMs: number;
  costUsd: number;
  energyUsed: number;
  carbonUsed?: number;
  stepsCompleted: number;
  totalSteps: number;
  errorMessage?: string;
  lessonsLearned?: string;
}

export interface ToolEffectiveness {
  toolName: string;
  totalUses: number;
  successRate: number;         // 0-1
  avgDurationMs: number;
  taskTypes: string[];         // which task types this tool is used for
  failureReasons: string[];    // common failure reasons
}

export interface TaskRecommendation {
  suggestedTools: string[];
  avoidTools: string[];
  estimatedSuccessRate: number;
  relevantEpisodes: MemoryEpisode[];
  warnings: string[];
  tips: string[];
}

export interface LearningStats {
  totalOutcomes: number;
  successRate: number;
  topTools: Array<{ tool: string; successRate: number; uses: number }>;
  commonFailures: Array<{ pattern: string; count: number; resolution?: string }>;
  taskTypeStats: Array<{ type: string; count: number; successRate: number }>;
}

// ── Tool tracker (in-memory aggregate) ───────────────────────────────

interface ToolRecord {
  successes: number;
  partials: number;
  failures: number;
  totalDurationMs: number;
  taskTypes: Set<string>;
  failureReasons: string[];
}

// ── Main class ───────────────────────────────────────────────────────

export class LongTermMemory {
  private memory: AgentMemory;
  private toolRecords = new Map<string, ToolRecord>();
  private taskTypeRecords = new Map<string, { successes: number; failures: number }>();
  private knownEpisodeIds = new Set<string>();
  private initialized = false;

  constructor(memory: AgentMemory) {
    this.memory = memory;
  }

  /**
   * Record a completed task outcome and extract lessons.
   * Call this after every task execution.
   */
  async recordOutcome(outcome: TaskOutcome): Promise<void> {
    // Load historical data first so we merge, not overwrite
    await this.ensureInitialized();

    // Track this episode ID so ensureInitialized doesn't double-count it
    const ep = await this.memory.recordEpisode(
      outcome.taskId,
      outcome.description,
      outcome.outcome,
      outcome.toolsUsed,
      outcome.energyUsed,
      outcome.carbonUsed ?? 0,
      [outcome.taskType, ...outcome.toolsUsed],
    );
    this.knownEpisodeIds.add(ep.id);

    // 2. Update tool effectiveness tracking
    for (const tool of outcome.toolsUsed) {
      const record = this.toolRecords.get(tool) ?? {
        successes: 0,
        partials: 0,
        failures: 0,
        totalDurationMs: 0,
        taskTypes: new Set<string>(),
        failureReasons: [],
      };

      if (outcome.outcome === 'success') {
        record.successes++;
      } else if (outcome.outcome === 'partial') {
        record.partials++;
      } else {
        record.failures++;
      }

      if (outcome.outcome !== 'success' && outcome.errorMessage) {
        record.failureReasons.push(outcome.errorMessage.slice(0, 200));
        // Keep only last 20 failure reasons
        if (record.failureReasons.length > 20) {
          record.failureReasons = record.failureReasons.slice(-20);
        }
      }

      record.totalDurationMs += outcome.durationMs;
      record.taskTypes.add(outcome.taskType);
      this.toolRecords.set(tool, record);
    }

    // 3. Update task type stats
    const typeRecord = this.taskTypeRecords.get(outcome.taskType) ?? { successes: 0, failures: 0 };
    if (outcome.outcome === 'success' || outcome.outcome === 'partial') {
      typeRecord.successes++;
    } else {
      typeRecord.failures++;
    }
    this.taskTypeRecords.set(outcome.taskType, typeRecord);

    // 4. Store lessons as semantic facts if available
    if (outcome.lessonsLearned) {
      await this.memory.storeFact(
        `lesson:${outcome.taskType}:${outcome.taskId}`,
        outcome.lessonsLearned,
        'lessons',
        `task:${outcome.taskId}`,
      );
    }

    // 5. If failed, store failure pattern
    if (outcome.outcome === 'failed' && outcome.errorMessage) {
      await this.memory.storeFact(
        `failure:${outcome.taskType}:${this.normalizeError(outcome.errorMessage)}`,
        {
          error: outcome.errorMessage,
          tools: outcome.toolsUsed,
          taskType: outcome.taskType,
          resolution: outcome.lessonsLearned,
        },
        'failure-patterns',
        `task:${outcome.taskId}`,
      );
    }
  }

  /**
   * Get recommendations for a new task based on past experience.
   */
  async getRecommendations(taskType: string, description: string): Promise<TaskRecommendation> {
    await this.ensureInitialized();

    // Find similar past episodes
    const episodes = await this.memory.searchEpisodes([taskType]);
    const recentEpisodes = await this.memory.getRecentEpisodes(50);

    // Filter relevant episodes
    const relevant = [
      ...episodes,
      ...recentEpisodes.filter(e => e.tags.includes(taskType)),
    ];

    // Deduplicate
    const seen = new Set<string>();
    const uniqueEpisodes = relevant.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    }).slice(0, 10);

    // Analyze tool effectiveness for this task type
    const suggestedTools: string[] = [];
    const avoidTools: string[] = [];

    for (const [tool, record] of this.toolRecords) {
      if (!record.taskTypes.has(taskType)) continue;
      const total = record.successes + record.partials + record.failures;
      if (total < 2) continue;

      const rate = (record.successes + record.partials * 0.5) / total;
      if (rate >= 0.7) {
        suggestedTools.push(tool);
      } else if (rate < 0.3 && total >= 3) {
        avoidTools.push(tool);
      }
    }

    // Calculate estimated success rate for this task type
    const typeStats = this.taskTypeRecords.get(taskType);
    let estimatedSuccessRate = 0.5; // default
    if (typeStats) {
      const total = typeStats.successes + typeStats.failures;
      if (total >= 2) {
        estimatedSuccessRate = typeStats.successes / total;
      }
    }

    // Extract warnings from past failures
    const warnings: string[] = [];
    const tips: string[] = [];

    const failedEpisodes = uniqueEpisodes.filter(e => e.outcome === 'failed');
    const successEpisodes = uniqueEpisodes.filter(e => e.outcome === 'success');

    if (failedEpisodes.length > successEpisodes.length) {
      warnings.push(`This task type has a higher failure rate (${failedEpisodes.length}/${uniqueEpisodes.length} failed)`);
    }

    // Get lessons learned from past successes
    const lessons = await this.memory.searchFacts({ category: 'lessons', limit: 5 });
    for (const lesson of lessons) {
      if (typeof lesson.value === 'string' && lesson.key.includes(taskType)) {
        tips.push(lesson.value);
      }
    }

    // Get failure pattern warnings
    const failures = await this.memory.searchFacts({ category: 'failure-patterns', limit: 5 });
    for (const f of failures) {
      const val = f.value as { error?: string; taskType?: string; resolution?: string } | undefined;
      if (val?.taskType === taskType) {
        warnings.push(`Past failure: ${val.error?.slice(0, 100)}`);
        if (val.resolution) {
          tips.push(`Fix: ${val.resolution}`);
        }
      }
    }

    return {
      suggestedTools,
      avoidTools,
      estimatedSuccessRate,
      relevantEpisodes: uniqueEpisodes,
      warnings: warnings.slice(0, 5),
      tips: tips.slice(0, 5),
    };
  }

  /**
   * Get effectiveness stats for all tools used.
   */
  async getToolEffectiveness(): Promise<ToolEffectiveness[]> {
    await this.ensureInitialized();

    const results: ToolEffectiveness[] = [];
    for (const [tool, record] of this.toolRecords) {
      const total = record.successes + record.partials + record.failures;
      // Partials count as half a success for the rate
      const effectiveSuccesses = record.successes + record.partials * 0.5;
      results.push({
        toolName: tool,
        totalUses: total,
        successRate: total > 0 ? effectiveSuccesses / total : 0,
        avgDurationMs: total > 0 ? record.totalDurationMs / total : 0,
        taskTypes: [...record.taskTypes],
        failureReasons: [...new Set(record.failureReasons)].slice(0, 5),
      });
    }

    return results.sort((a, b) => b.totalUses - a.totalUses);
  }

  /**
   * Get overall learning statistics.
   */
  async getStats(): Promise<LearningStats> {
    await this.ensureInitialized();

    const episodes = await this.memory.getRecentEpisodes(1000);
    const totalOutcomes = episodes.length;
    const successes = episodes.filter(e => e.outcome === 'success' || e.outcome === 'partial').length;

    const toolEffectiveness = await this.getToolEffectiveness();
    const topTools = toolEffectiveness
      .filter(t => t.totalUses >= 2)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10)
      .map(t => ({ tool: t.toolName, successRate: t.successRate, uses: t.totalUses }));

    const failures = await this.memory.searchFacts({ category: 'failure-patterns', limit: 20 });
    const commonFailures = failures.map(f => {
      const val = f.value as { error?: string; resolution?: string } | undefined;
      return {
        pattern: val?.error?.slice(0, 100) ?? f.key,
        count: 1,
        resolution: val?.resolution,
      };
    });

    const taskTypeStats: LearningStats['taskTypeStats'] = [];
    for (const [type, record] of this.taskTypeRecords) {
      const total = record.successes + record.failures;
      taskTypeStats.push({
        type,
        count: total,
        successRate: total > 0 ? record.successes / total : 0,
      });
    }

    return {
      totalOutcomes,
      successRate: totalOutcomes > 0 ? successes / totalOutcomes : 0,
      topTools,
      commonFailures,
      taskTypeStats: taskTypeStats.sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Build working memory context from past experience for a given task.
   * Returns a formatted string suitable for injection into agent prompts.
   */
  async buildContextForTask(taskType: string, description: string): Promise<string> {
    const rec = await this.getRecommendations(taskType, description);
    const lines: string[] = [];

    if (rec.relevantEpisodes.length > 0) {
      lines.push('## Past Experience');
      for (const ep of rec.relevantEpisodes.slice(0, 3)) {
        lines.push(`- [${ep.outcome}] ${ep.summary} (tools: ${ep.toolsUsed.join(', ')})`);
      }
    }

    if (rec.suggestedTools.length > 0) {
      lines.push(`\n## Recommended Tools: ${rec.suggestedTools.join(', ')}`);
    }

    if (rec.avoidTools.length > 0) {
      lines.push(`## Avoid: ${rec.avoidTools.join(', ')}`);
    }

    if (rec.warnings.length > 0) {
      lines.push('\n## Warnings');
      for (const w of rec.warnings) {
        lines.push(`- ${w}`);
      }
    }

    if (rec.tips.length > 0) {
      lines.push('\n## Tips from past runs');
      for (const t of rec.tips) {
        lines.push(`- ${t}`);
      }
    }

    return lines.join('\n');
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Hydrate tool records from existing episodic memory.
   * Only done once per session. Skips episodes already counted
   * by recordOutcome() in the current session (tracked via knownEpisodeIds).
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const episodes = await this.memory.getRecentEpisodes(200);

    for (const ep of episodes) {
      // Skip episodes already counted in this session
      if (this.knownEpisodeIds.has(ep.id)) continue;

      const taskType = ep.tags[0] ?? 'unknown';

      for (const tool of ep.toolsUsed) {
        const record = this.toolRecords.get(tool) ?? {
          successes: 0,
          partials: 0,
          failures: 0,
          totalDurationMs: 0,
          taskTypes: new Set<string>(),
          failureReasons: [],
        };

        if (ep.outcome === 'success') {
          record.successes++;
        } else if (ep.outcome === 'partial') {
          record.partials++;
        } else {
          record.failures++;
        }

        record.taskTypes.add(taskType);
        this.toolRecords.set(tool, record);
      }

      const typeRecord = this.taskTypeRecords.get(taskType) ?? { successes: 0, failures: 0 };
      if (ep.outcome === 'success' || ep.outcome === 'partial') {
        typeRecord.successes++;
      } else {
        typeRecord.failures++;
      }
      this.taskTypeRecords.set(taskType, typeRecord);
    }
  }

  private normalizeError(error: string): string {
    // Strip dynamic parts (line numbers, timestamps, IDs) for pattern matching
    return error
      .replace(/\d+/g, 'N')
      .replace(/[a-f0-9]{8,}/gi, 'ID')
      .slice(0, 100);
  }
}
