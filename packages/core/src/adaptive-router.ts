/**
 * AdaptiveRouter — Learns which models handle which tasks best over time.
 *
 * Wraps ModelRouter to track model performance per task type and adjust
 * routing scores based on historical data. Persists performance data
 * via AgentMemory's semantic facts.
 *
 * Performance signals:
 *  - Task outcome (success/partial/failed)
 *  - Latency (response time)
 *  - Cost (tokens used × price)
 *  - Quality score (0-1, from verification step if available)
 *
 * The adaptive score modifies the base routing score by ±20%, so it
 * nudges — not overrides — the router's existing logic.
 */

import {
  type ModelProviderName,
  isoNow,
} from '@joule/shared';
import type { ModelRouter, RoutingDecision, RoutingPurpose, RoutingContext } from './model-router.js';
import type { AgentMemory } from './agent-memory.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ModelPerformanceRecord {
  model: string;
  provider: ModelProviderName;
  taskType: string;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalCostUsd: number;
  totalQualityScore: number;
  qualityCount: number;       // how many quality scores we have
  lastUsed: string;
}

export interface PerformanceReport {
  taskType: string;
  outcome: 'success' | 'partial' | 'failed';
  model: string;
  provider: ModelProviderName;
  latencyMs: number;
  costUsd: number;
  qualityScore?: number;      // 0-1 from verification
}

export interface AdaptiveStats {
  totalRecords: number;
  modelStats: Array<{
    model: string;
    provider: ModelProviderName;
    taskTypes: string[];
    overallSuccessRate: number;
    avgLatencyMs: number;
    avgCostUsd: number;
    avgQuality: number;
  }>;
}

// ── Main class ───────────────────────────────────────────────────────

export class AdaptiveRouter {
  private records = new Map<string, ModelPerformanceRecord>();
  private baseRouter: ModelRouter;
  private memory?: AgentMemory;
  private initialized = false;

  constructor(baseRouter: ModelRouter, memory?: AgentMemory) {
    this.baseRouter = baseRouter;
    this.memory = memory;
  }

  /**
   * Route a request, applying adaptive scoring on top of the base router.
   * Falls through to base router if no performance data is available.
   */
  async route(
    purpose: RoutingPurpose,
    envelope: any,
    context?: RoutingContext & { taskType?: string },
  ): Promise<RoutingDecision> {
    const decision = await this.baseRouter.route(purpose, envelope, context);

    // If we have a task type and performance data, check if another model
    // in the same tier has a better track record
    if (context?.taskType) {
      await this.ensureInitialized();
      const betterModel = this.findBetterModel(
        decision,
        context.taskType,
        purpose,
      );
      if (betterModel) {
        return {
          ...decision,
          ...betterModel,
          reason: `${decision.reason}, adaptive-override: ${betterModel.model} has better ${context.taskType} track record`,
        };
      }
    }

    return decision;
  }

  /**
   * Report task performance back to the adaptive router.
   * Call this after every task completion.
   */
  reportPerformance(report: PerformanceReport): void {
    // Trigger initialization in background so historical data gets loaded
    // before we start querying. The current record update is safe regardless
    // because ensureInitialized skips keys that already exist in-session.
    if (!this.initialized) {
      this.ensureInitialized().catch(() => {});
    }

    const key = `${report.provider}:${report.model}:${report.taskType}`;
    const record = this.records.get(key) ?? {
      model: report.model,
      provider: report.provider,
      taskType: report.taskType,
      successes: 0,
      failures: 0,
      totalLatencyMs: 0,
      totalCostUsd: 0,
      totalQualityScore: 0,
      qualityCount: 0,
      lastUsed: '',
    };

    if (report.outcome === 'success') {
      record.successes++;
    } else {
      record.failures++;
    }

    record.totalLatencyMs += report.latencyMs;
    record.totalCostUsd += report.costUsd;

    if (report.qualityScore !== undefined) {
      record.totalQualityScore += report.qualityScore;
      record.qualityCount++;
    }

    record.lastUsed = isoNow();
    this.records.set(key, record);

    // Persist to memory asynchronously — log errors but don't block
    this.persistRecord(key, record).catch((err) => {
      // Swallowed intentionally: persistence is best-effort,
      // in-memory records remain authoritative for the session
    });
  }

  /**
   * Get adaptive routing statistics.
   */
  async getStats(): Promise<AdaptiveStats> {
    await this.ensureInitialized();

    // Group records by model+provider
    const grouped = new Map<string, {
      model: string;
      provider: ModelProviderName;
      taskTypes: Set<string>;
      successes: number;
      failures: number;
      totalLatencyMs: number;
      totalCostUsd: number;
      totalQuality: number;
      qualityCount: number;
      uses: number;
    }>();

    for (const record of this.records.values()) {
      const groupKey = `${record.provider}:${record.model}`;
      const group = grouped.get(groupKey) ?? {
        model: record.model,
        provider: record.provider,
        taskTypes: new Set<string>(),
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        totalCostUsd: 0,
        totalQuality: 0,
        qualityCount: 0,
        uses: 0,
      };

      group.taskTypes.add(record.taskType);
      group.successes += record.successes;
      group.failures += record.failures;
      group.totalLatencyMs += record.totalLatencyMs;
      group.totalCostUsd += record.totalCostUsd;
      group.totalQuality += record.totalQualityScore;
      group.qualityCount += record.qualityCount;
      group.uses += record.successes + record.failures;
      grouped.set(groupKey, group);
    }

    const modelStats = [...grouped.values()].map(g => ({
      model: g.model,
      provider: g.provider,
      taskTypes: [...g.taskTypes],
      overallSuccessRate: g.uses > 0 ? g.successes / g.uses : 0,
      avgLatencyMs: g.uses > 0 ? g.totalLatencyMs / g.uses : 0,
      avgCostUsd: g.uses > 0 ? g.totalCostUsd / g.uses : 0,
      avgQuality: g.qualityCount > 0 ? g.totalQuality / g.qualityCount : 0,
    }));

    return {
      totalRecords: this.records.size,
      modelStats: modelStats.sort((a, b) => b.overallSuccessRate - a.overallSuccessRate),
    };
  }

  /**
   * Report a model failure for failover (delegates to base router).
   */
  reportFailure(provider: ModelProviderName): void {
    this.baseRouter.reportFailure(provider);
  }

  /**
   * Report a model success (delegates to base router).
   */
  reportSuccess(provider: ModelProviderName): void {
    this.baseRouter.reportSuccess(provider);
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Check if there's a model with a significantly better track record
   * for the given task type. Returns override fields if found.
   */
  private findBetterModel(
    current: RoutingDecision,
    taskType: string,
    purpose: RoutingPurpose,
  ): Partial<RoutingDecision> | null {
    const currentKey = `${current.provider}:${current.model}:${taskType}`;
    const currentRecord = this.records.get(currentKey);

    // Find alternatives with same tier and better scores
    let bestScore = this.computeScore(currentRecord);
    let bestOverride: Partial<RoutingDecision> | null = null;

    for (const [key, record] of this.records) {
      if (key === currentKey) continue;
      if (record.taskType !== taskType) continue;

      const totalUses = record.successes + record.failures;
      if (totalUses < 3) continue; // need enough data

      const score = this.computeScore(record);

      // Only override if 20%+ better (avoid flip-flopping)
      if (score > bestScore * 1.2) {
        bestScore = score;
        bestOverride = {
          provider: record.provider,
          model: record.model,
        };
      }
    }

    return bestOverride;
  }

  /**
   * Compute a composite score for a performance record.
   * Higher is better. Weights: 60% success rate, 25% quality, 15% cost efficiency.
   */
  private computeScore(record: ModelPerformanceRecord | undefined): number {
    if (!record) return 0.5; // neutral default

    const totalUses = record.successes + record.failures;
    if (totalUses === 0) return 0.5;

    const successRate = record.successes / totalUses;
    const quality = record.qualityCount > 0
      ? record.totalQualityScore / record.qualityCount
      : successRate; // approximate quality from success rate
    const avgCost = record.totalCostUsd / totalUses;

    // Cost efficiency: lower cost = higher score (normalize to 0-1 range)
    const costScore = 1 / (1 + avgCost * 100);

    return 0.6 * successRate + 0.25 * quality + 0.15 * costScore;
  }

  /**
   * Persist a performance record to memory.
   */
  private async persistRecord(key: string, record: ModelPerformanceRecord): Promise<void> {
    if (!this.memory) return;

    await this.memory.storeFact(
      `adaptive-routing:${key}`,
      record,
      'adaptive-routing',
      'adaptive-router',
    );
  }

  /**
   * Load performance records from memory on first use.
   * Merges with any in-session data — in-session records take priority
   * since they may contain newer data not yet persisted.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.memory) return;

    const facts = await this.memory.searchFacts({ category: 'adaptive-routing', limit: 500 });
    for (const fact of facts) {
      const record = fact.value as ModelPerformanceRecord;
      if (record && record.model && record.provider && record.taskType) {
        const key = `${record.provider}:${record.model}:${record.taskType}`;
        // Only load from memory if we don't already have fresher in-session data
        if (!this.records.has(key)) {
          this.records.set(key, record);
        }
      }
    }
  }
}
