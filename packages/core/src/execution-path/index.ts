/**
 * ExecutionPathSelector
 *
 * The unified entry point for learned execution path prediction.
 *
 * Given a task, selects the optimal path (P0–P5) before any execution begins:
 *
 *   Task arrives
 *       ↓
 *   [Cache Lookup] — P0 hit? → Return cached result. Zero LLM calls.
 *       ↓ miss
 *   [Classifier] — Single SLM call, ~150 tokens
 *       ↓
 *   ├── P1: Direct Answer → Single SLM call → Done
 *   ├── P2: Template Match → Template executor → Done
 *   ├── P3: Chunked Pipeline → Parallel SLM calls → Combine → Done
 *   ├── P4: Planned + Pruning → Full Joule pipeline → Done (existing flow)
 *   └── P5: Full Escalation → Joule + LLM tier → Done (existing flow)
 *       ↓
 *   [Outcome Logger] → Update cache + correction table
 *
 * P4 and P5 fall through to the existing task-executor state machine.
 * P0–P3 are handled entirely here — no planning, no tool calls.
 */

export { ExecutionPathClassifier } from './classifier.js';
export { SemanticCache } from './semantic-cache.js';
export { ChunkedPipeline } from './chunked-pipeline.js';
export { AdaptiveLearner } from './adaptive-learner.js';
export { matchTemplate, fillTemplate, TEMPLATE_LIBRARY, TEMPLATE_KEYS } from './template-library.js';

import type { Task } from '@joule/shared';
import type {
  ExecutionProfile,
  ExecutionPathId,
  ExecutionOutcome,
  ExecutionPathConfig,
} from '@joule/shared';
import type { ModelRouter } from '../model-router.js';
import type { BudgetEnvelopeInstance } from '../budget-manager.js';
import type { BudgetManager } from '../budget-manager.js';
import type { TraceLogger } from '../trace-logger.js';
import type { ToolRegistry } from '../tool-registry.js';
import { ExecutionPathClassifier } from './classifier.js';
import { SemanticCache } from './semantic-cache.js';
import { ChunkedPipeline } from './chunked-pipeline.js';
import { AdaptiveLearner } from './adaptive-learner.js';
import { matchTemplate } from './template-library.js';

export interface PathSelectionResult {
  /** Which path was selected */
  profile: ExecutionProfile;
  /** If P0–P3: the complete result (skip task-executor) */
  earlyResult?: string;
  /** If P0: the cache entry similarity score */
  cacheSimilarity?: number;
  /** Whether this result was from cache */
  fromCache: boolean;
}

/**
 * Main facade. Instantiate once and share across task executions.
 */
export class ExecutionPathSelector {
  private readonly classifier: ExecutionPathClassifier;
  private readonly cache: SemanticCache;
  private readonly pipeline: ChunkedPipeline;
  private readonly learner: AdaptiveLearner;
  private readonly config: ExecutionPathConfig;
  private readonly classifierOnly: boolean;

  constructor(
    router: ModelRouter,
    budget: BudgetManager,
    tracer: TraceLogger,
    config?: Partial<ExecutionPathConfig> & { _classifierOnly?: boolean },
  ) {
    this.classifierOnly = (config as any)?._classifierOnly ?? false;
    this.config = {
      enabled: config?.enabled ?? true,
      cache: {
        enabled: this.classifierOnly ? false : (config?.cache?.enabled ?? true),
        similarityThreshold: config?.cache?.similarityThreshold ?? 0.92,
        maxEntries: config?.cache?.maxEntries ?? 10_000,
        dbPath: config?.cache?.dbPath ?? '.joule/cache.json',
      },
      learner: {
        enabled: config?.learner?.enabled ?? true,
        updateIntervalTasks: config?.learner?.updateIntervalTasks ?? 20,
        correctionTablePath: config?.learner?.correctionTablePath ?? '.joule/corrections.json',
      },
    };

    this.classifier = new ExecutionPathClassifier(router, budget, tracer);
    this.cache = new SemanticCache(this.config.cache);
    this.pipeline = new ChunkedPipeline(router, budget, tracer);
    this.learner = new AdaptiveLearner(this.config.learner);
  }

  /**
   * Select and (for P0–P3) execute the optimal path for a task.
   *
   * Returns a PathSelectionResult with:
   * - profile: the selected ExecutionProfile
   * - earlyResult: for P0–P3, the complete answer (skip task-executor)
   * - fromCache: whether result came from semantic cache
   *
   * For P4/P5, earlyResult is undefined — caller runs the normal pipeline.
   */
  async select(
    task: Task,
    tools: ToolRegistry,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<PathSelectionResult> {
    if (!this.config.enabled) {
      // System disabled — default to P4
      return {
        profile: {
          path: 4,
          confidence: 1.0,
          modelTier: 'slm',
          predictedEnergyWh: 0.001,
          predictedQuality: 4.0,
          rationale: 'Execution path selection disabled',
        },
        fromCache: false,
      };
    }

    // P0: Cache lookup
    if (this.config.cache.enabled) {
      const cacheResult = this.cache.lookup(task.description);
      if (cacheResult.hit && cacheResult.entry) {
        return {
          profile: {
            path: 0,
            confidence: cacheResult.similarity ?? 1.0,
            modelTier: 'slm',
            predictedEnergyWh: 0,
            predictedQuality: cacheResult.entry.qualityScore,
            rationale: `Cache hit (similarity=${(cacheResult.similarity ?? 0).toFixed(3)})`,
          },
          earlyResult: cacheResult.entry.result,
          cacheSimilarity: cacheResult.similarity,
          fromCache: true,
        };
      }
    }

    // Classify the task
    const toolNames = tools.listNames();
    const profile = await this.classifier.classify(task.description, toolNames, envelope, traceId);

    // Apply adaptive corrections
    if (this.config.learner.enabled) {
      const correction = this.learner.applyCorrection(task.description, profile);
      if (correction !== null && correction !== profile.path) {
        profile.path = correction;
        profile.rationale = `[corrected by learner] ${profile.rationale}`;
      }
    }

    // P1: Direct answer — single SLM call (handled by task-executor fast_path, signal it)
    if (profile.path <= 1) {
      return { profile, fromCache: false };
    }

    // P2: Template execution (skipped in classifierOnly mode)
    if (profile.path === 2 && !this.classifierOnly) {
      const templateKey = profile.template;
      const template = templateKey
        ? (await import('./template-library.js')).TEMPLATE_LIBRARY[templateKey]
        : matchTemplate(task.description);

      if (template) {
        let earlyResult: string;
        if (template.chunkPrompt) {
          const result = await this.pipeline.execute(task.description, template, envelope, traceId);
          earlyResult = result.output;
        } else {
          earlyResult = await this.pipeline.executeTemplate(task.description, template, envelope, traceId);
        }
        return { profile, earlyResult, fromCache: false };
      }
      // No template matched — fall through to P4
      profile.path = 4;
      profile.rationale = `Template not found — escalating to planned execution`;
    } else if (profile.path === 2 && this.classifierOnly) {
      // classifierOnly: route to P4 but record classifier said P2
      profile.rationale = `[classifierOnly] would be P2 — using P4`;
    }

    // P3: Chunked pipeline
    if (profile.path === 3 && !this.classifierOnly) {
      const template = matchTemplate(task.description) ?? {
        key: 'generic_chunk',
        name: 'Generic Chunked',
        triggerKeywords: [],
        categories: [],
        promptTemplate: '{description}',
        chunkPrompt: 'Summarize this section:\n\n{chunk}',
        combinePrompt: 'Combine these summaries:\n\n{summaries}',
        chunkSize: profile.chunkSize ?? 500,
        modelTier: 'slm' as const,
        estimatedEnergyWh: 0.0004,
      };

      const result = await this.pipeline.execute(task.description, template, envelope, traceId);
      return { profile, earlyResult: result.output, fromCache: false };
    } else if (profile.path === 3 && this.classifierOnly) {
      profile.rationale = `[classifierOnly] would be P3 — using P4`;
    }

    // P4/P5: Fall through to full task-executor pipeline
    return { profile, fromCache: false };
  }

  /**
   * Record an outcome after task completion.
   * Updates cache (for successful results) and adaptive learner.
   */
  recordOutcome(
    task: Task,
    result: string,
    profile: ExecutionProfile,
    actualPath: ExecutionPathId,
    actualEnergyWh: number,
    actualQuality: number,
    actualLatencyMs: number,
  ): void {
    // Store in semantic cache if quality is good
    if (actualQuality >= 3.5 && result && !profile.fromCache) {
      this.cache.store(task.description, result, actualQuality, actualEnergyWh, actualPath);
    }

    if (!this.config.learner.enabled) return;

    // Determine if prediction was better or worse than optimal
    // A misprediction is when the actual path was cheaper AND quality was still good
    const mispredicted =
      actualPath !== profile.path &&
      actualQuality >= 4.0;

    const betterPath: ExecutionPathId | null =
      actualPath < profile.path && actualQuality >= 4.0
        ? actualPath
        : null;

    const outcome: ExecutionOutcome = {
      taskId: task.id,
      taskDescription: task.description,
      profile,
      actualPath,
      actualEnergyWh,
      actualQuality,
      actualLatencyMs,
      mispredicted,
      betterPathWouldHaveBeen: betterPath,
      timestamp: new Date().toISOString(),
    };

    this.learner.record(outcome);
  }

  // Expose sub-component stats for benchmarking
  getCacheStats() { return this.cache.getStats(); }
  getLearnerStats() { return this.learner.getStats(); }
  getLearningCurve(windowSize?: number) { return this.learner.getLearningCurve(windowSize); }

  // Expose for profile.fromCache check
  private get fromCache() { return false; }
}

// Augment ExecutionProfile with internal marker (not in shared types)
declare module '@joule/shared' {
  interface ExecutionProfile {
    fromCache?: boolean;
  }
}
