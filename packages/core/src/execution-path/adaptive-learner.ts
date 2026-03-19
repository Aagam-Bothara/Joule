/**
 * AdaptiveLearner
 *
 * Logs execution outcomes and maintains a correction table.
 * After every N tasks, identifies patterns where the classifier mispredicts
 * and builds override rules that short-circuit future classification.
 *
 * This produces the "learning curve" figure for the paper:
 * misprediction rate should decrease as the correction table grows.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ExecutionOutcome, ExecutionPathId, ExecutionProfile } from '@joule/shared';

const DEFAULT_UPDATE_INTERVAL = 20;
const DEFAULT_CORRECTIONS_PATH = '.joule/corrections.json';

/** A learned correction rule: tasks matching this pattern → use this path */
export interface CorrectionRule {
  id: string;
  pattern: string;              // lowercase substring to match in task description
  predictedPath: ExecutionPathId; // what classifier predicted
  actualBetterPath: ExecutionPathId; // what would have been better
  confidence: number;           // 0–1, based on sample size
  sampleCount: number;
  energySavingsWh: number;      // total energy saved by this rule
  createdAt: string;
  lastUpdated: string;
}

export interface LearnerStats {
  totalOutcomes: number;
  mispredictionRate: number;
  correctionRuleCount: number;
  totalEnergySavedByCorrections: number;
  recentAccuracy: number;       // last 20 tasks
}

export class AdaptiveLearner {
  private outcomes: ExecutionOutcome[] = [];
  private correctionTable: Map<string, CorrectionRule> = new Map();
  private readonly updateInterval: number;
  private readonly correctionsPath: string;
  private tasksSinceLastUpdate = 0;

  constructor(options?: {
    updateIntervalTasks?: number;
    correctionTablePath?: string;
  }) {
    this.updateInterval = options?.updateIntervalTasks ?? DEFAULT_UPDATE_INTERVAL;
    this.correctionsPath = options?.correctionTablePath ?? DEFAULT_CORRECTIONS_PATH;
    this.load();
  }

  /**
   * Log a completed task outcome.
   * Triggers correction table update every N tasks.
   */
  record(outcome: ExecutionOutcome): void {
    this.outcomes.push(outcome);
    this.tasksSinceLastUpdate++;

    if (this.tasksSinceLastUpdate >= this.updateInterval) {
      this.updateCorrectionTable();
      this.tasksSinceLastUpdate = 0;
      this.save();
    }
  }

  /**
   * Check if a correction rule applies to this task description.
   * Returns the corrected path if found, null otherwise.
   */
  applyCorrection(
    description: string,
    predictedProfile: ExecutionProfile,
  ): ExecutionPathId | null {
    const lower = description.toLowerCase();

    for (const rule of this.correctionTable.values()) {
      if (
        rule.predictedPath === predictedProfile.path &&
        rule.confidence >= 0.7 &&
        lower.includes(rule.pattern)
      ) {
        return rule.actualBetterPath;
      }
    }

    return null;
  }

  /** Get stats for benchmark/paper metrics */
  getStats(): LearnerStats {
    const total = this.outcomes.length;
    if (total === 0) {
      return {
        totalOutcomes: 0,
        mispredictionRate: 0,
        correctionRuleCount: 0,
        totalEnergySavedByCorrections: 0,
        recentAccuracy: 1,
      };
    }

    const mispredictions = this.outcomes.filter(o => o.mispredicted).length;
    const recent = this.outcomes.slice(-20);
    const recentMispredictions = recent.filter(o => o.mispredicted).length;

    let totalEnergySaved = 0;
    for (const rule of this.correctionTable.values()) {
      totalEnergySaved += rule.energySavingsWh;
    }

    return {
      totalOutcomes: total,
      mispredictionRate: mispredictions / total,
      correctionRuleCount: this.correctionTable.size,
      totalEnergySavedByCorrections: totalEnergySaved,
      recentAccuracy: 1 - recentMispredictions / recent.length,
    };
  }

  /**
   * Compute the learning curve: accuracy at each checkpoint of N tasks.
   * Returns array of { taskCount, accuracy } for plotting.
   */
  getLearningCurve(windowSize = 20): Array<{ taskCount: number; accuracy: number }> {
    const curve: Array<{ taskCount: number; accuracy: number }> = [];
    for (let i = windowSize; i <= this.outcomes.length; i += windowSize) {
      const window = this.outcomes.slice(i - windowSize, i);
      const correct = window.filter(o => !o.mispredicted).length;
      curve.push({ taskCount: i, accuracy: correct / window.length });
    }
    return curve;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Analyze recent outcomes to identify recurring misprediction patterns.
   * For each mispredicted task, extract keyword patterns and build/update rules.
   */
  private updateCorrectionTable(): void {
    const recent = this.outcomes.slice(-this.updateInterval * 3); // look at last 3 intervals
    const mispredicted = recent.filter(o => o.mispredicted && o.betterPathWouldHaveBeen !== null);

    // Group by (predicted path → actual better path) + keyword
    const patternCounts = new Map<string, {
      predictedPath: ExecutionPathId;
      betterPath: ExecutionPathId;
      count: number;
      totalEnergySaved: number;
    }>();

    for (const outcome of mispredicted) {
      if (outcome.betterPathWouldHaveBeen === null) continue;

      const keywords = this.extractKeywords(outcome.taskDescription);
      for (const kw of keywords) {
        const key = `${outcome.profile.path}→${outcome.betterPathWouldHaveBeen}:${kw}`;
        const existing = patternCounts.get(key);
        const energySaved = outcome.actualEnergyWh - (outcome.profile.predictedEnergyWh * 0.8);

        if (existing) {
          existing.count++;
          existing.totalEnergySaved += Math.max(0, energySaved);
        } else {
          patternCounts.set(key, {
            predictedPath: outcome.profile.path,
            betterPath: outcome.betterPathWouldHaveBeen,
            count: 1,
            totalEnergySaved: Math.max(0, energySaved),
          });
        }
      }
    }

    // Create/update rules for patterns seen ≥ 2 times
    for (const [key, data] of patternCounts) {
      if (data.count < 2) continue;

      const pattern = key.split(':')[1];
      const existing = this.correctionTable.get(key);

      if (existing) {
        existing.sampleCount += data.count;
        existing.confidence = Math.min(0.99, existing.sampleCount / (existing.sampleCount + 5));
        existing.energySavingsWh += data.totalEnergySaved;
        existing.lastUpdated = new Date().toISOString();
      } else {
        this.correctionTable.set(key, {
          id: key,
          pattern,
          predictedPath: data.predictedPath,
          actualBetterPath: data.betterPath,
          confidence: data.count / (data.count + 5), // conservative initial confidence
          sampleCount: data.count,
          energySavingsWh: data.totalEnergySaved,
          createdAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
        });
      }
    }
  }

  /** Extract significant keywords from a task description */
  private extractKeywords(description: string): string[] {
    const stopWords = new Set(['a', 'an', 'the', 'this', 'that', 'is', 'are', 'was',
      'to', 'for', 'of', 'in', 'on', 'at', 'with', 'and', 'or', 'but', 'not',
      'it', 'its', 'be', 'do', 'can', 'will', 'my', 'me', 'i', 'you', 'we']);

    return description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
      .slice(0, 5); // top 5 words only
  }

  private load(): void {
    try {
      if (!existsSync(this.correctionsPath)) return;
      const raw = readFileSync(this.correctionsPath, 'utf8');
      const data = JSON.parse(raw) as {
        corrections?: Array<[string, CorrectionRule]>;
        outcomes?: ExecutionOutcome[];
      };

      if (data.corrections) {
        this.correctionTable = new Map(data.corrections);
      }
      if (data.outcomes) {
        // Keep last 500 outcomes in memory
        this.outcomes = data.outcomes.slice(-500);
      }
    } catch {
      // Start fresh
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.correctionsPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const data = {
        corrections: Array.from(this.correctionTable.entries()),
        outcomes: this.outcomes.slice(-500),
        stats: this.getStats(),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(this.correctionsPath, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      // Non-fatal
    }
  }
}
