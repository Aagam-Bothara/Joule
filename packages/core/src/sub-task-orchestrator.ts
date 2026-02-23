import {
  type Task,
  type TaskResult,
  type DecompositionPlan,
  type SubTaskDefinition,
  type ModelRequest,
  type ChatMessage,
  type EnergyConfig,
  type RoutingConfig,
  ModelTier,
  generateId,
  isoNow,
} from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import { BudgetManager, type BudgetEnvelopeInstance } from './budget-manager.js';
import { ModelRouter } from './model-router.js';
import { TraceLogger } from './trace-logger.js';
import { ToolRegistry } from './tool-registry.js';
import { Planner } from './planner.js';
import { TaskExecutor, type ProgressCallback } from './task-executor.js';
import type { ConstitutionEnforcer } from './constitution.js';

const DECOMPOSE_SYSTEM_PROMPT = `You are a task decomposition specialist. Break complex tasks into independent sub-tasks that can be executed sequentially.

Rules:
- Each sub-task should be self-contained and clearly described
- Identify dependencies between sub-tasks (which ones need results from others)
- Assign budget shares (fractions that sum to 1.0)
- Keep decomposition minimal — prefer fewer, well-scoped sub-tasks

Respond with ONLY a raw JSON object (no markdown, no code fences):
{"subTasks": [{"description": "<what to do>", "dependsOn": [], "budgetShare": <0-1>}], "strategy": "sequential"|"parallel"|"mixed", "aggregation": "<how to combine results>"}`;

/** Compound-task indicators used by shouldDecompose. */
const COMPOUND_PATTERNS = [
  /\band\s+then\b/i,
  /\bafter\s+that\b/i,
  /\bfirst\s*,?\s*.*\bthen\b/i,
  /\bnext\s*,?\s*/i,
  /\bfinally\b/i,
  /\b(?:step\s*\d|task\s*\d)/i,
  /\d+\)\s+/,    // "1) do X, 2) do Y"
  /[-•]\s+/,     // bullet list
];

/**
 * Decomposes complex tasks into sub-tasks and orchestrates their execution.
 */
export class SubTaskOrchestrator {
  constructor(
    private planner: Planner,
    private budget: BudgetManager,
    private router: ModelRouter,
    private tracer: TraceLogger,
    private tools: ToolRegistry,
    private providers: ModelProviderRegistry,
    private energyConfig?: EnergyConfig,
    private routingConfig?: RoutingConfig,
    private constitution?: ConstitutionEnforcer,
  ) {}

  /**
   * Determine if a task should be decomposed into sub-tasks.
   * Only triggers for high-complexity, compound tasks.
   */
  shouldDecompose(task: Task, complexity: number): boolean {
    if (complexity <= 0.85) return false;
    if (task.description.length <= 200) return false;
    return this.hasCompoundStructure(task.description);
  }

  /**
   * Use LLM to decompose a task into sub-tasks.
   */
  async decompose(
    task: Task,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<DecompositionPlan> {
    try {
      const decision = await this.router.route('plan', envelope, 0.85);
      const provider = this.providers.get(decision.provider);
      if (!provider) return this.fallbackPlan(task);

      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier as ModelTier,
        system: DECOMPOSE_SYSTEM_PROMPT,
        messages: [{
          role: 'user' as const,
          content: `Decompose this task:\n\n${task.description}`,
        } satisfies ChatMessage],
        responseFormat: 'json',
        temperature: 0.2,
      };

      const response = await provider.chat(request);
      this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budget.deductCost(envelope, response.costUsd);

      const parsed = JSON.parse(response.content) as {
        subTasks?: Array<{ description: string; dependsOn?: string[]; budgetShare?: number }>;
        strategy?: string;
        aggregation?: string;
      };

      if (!parsed.subTasks || parsed.subTasks.length === 0) {
        return this.fallbackPlan(task);
      }

      // Normalize budget shares to sum to 1.0
      const totalShare = parsed.subTasks.reduce((sum, s) => sum + (s.budgetShare ?? 0), 0);
      const normalizer = totalShare > 0 ? 1.0 / totalShare : 1.0 / parsed.subTasks.length;

      const subTasks: SubTaskDefinition[] = parsed.subTasks.map((st, idx) => ({
        id: generateId('subtask'),
        description: st.description,
        parentTaskId: task.id,
        dependsOn: st.dependsOn ?? [],
        budgetShare: totalShare > 0
          ? (st.budgetShare ?? 0) * normalizer
          : 1.0 / parsed.subTasks!.length,
      }));

      // Resolve dependsOn indices to actual sub-task IDs
      for (const st of subTasks) {
        st.dependsOn = st.dependsOn.map(dep => {
          const idx = parseInt(dep, 10);
          if (!isNaN(idx) && idx >= 0 && idx < subTasks.length) {
            return subTasks[idx].id;
          }
          return dep;
        }).filter(dep => subTasks.some(s => s.id === dep));
      }

      this.tracer.logEvent(traceId, 'decomposition', {
        subTaskCount: subTasks.length,
        strategy: parsed.strategy ?? 'sequential',
      });

      return {
        subTasks,
        strategy: (parsed.strategy as DecompositionPlan['strategy']) ?? 'sequential',
        aggregation: parsed.aggregation ?? 'Combine all sub-task results',
      };
    } catch {
      return this.fallbackPlan(task);
    }
  }

  /**
   * Execute sub-tasks in dependency order.
   */
  async executeDecomposed(
    task: Task,
    plan: DecompositionPlan,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    onProgress?: ProgressCallback,
  ): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    const resultMap = new Map<string, TaskResult>();

    // Topological sort by dependencies
    const ordered = this.topologicalSort(plan.subTasks);

    for (const subTask of ordered) {
      // Build context from dependency results
      const depResults = subTask.dependsOn
        .map(id => resultMap.get(id))
        .filter((r): r is TaskResult => r !== undefined);

      const enrichedDesc = this.enrichWithDependencyResults(subTask.description, depResults);

      // Create sub-envelope
      const subEnvelope = this.budget.createSubEnvelope(envelope, subTask.budgetShare);

      // Create child task
      const childTask: Task = {
        id: subTask.id,
        description: enrichedDesc,
        budget: subTask.budgetShare,
        tools: subTask.tools,
        createdAt: isoNow(),
      };

      // Execute via a fresh TaskExecutor (shares budget via parent mirroring)
      const executor = new TaskExecutor(
        this.budget,
        this.router,
        this.tracer,
        this.tools,
        this.planner,
        this.providers,
        this.energyConfig,
        this.routingConfig,
        this.constitution,
      );

      const result = await executor.execute(childTask, onProgress);
      results.push(result);
      resultMap.set(subTask.id, result);
    }

    return results;
  }

  /**
   * Combine sub-task results into a single output string.
   */
  aggregateResults(results: TaskResult[], aggregation: string): string {
    if (results.length === 0) return 'No sub-tasks executed.';
    if (results.length === 1) return results[0].result ?? 'Completed.';

    const parts = results.map((r, i) =>
      `[Sub-task ${i + 1}]: ${r.result ?? (r.status === 'completed' ? 'Completed' : `Failed: ${r.error ?? 'unknown'}`)}`
    );

    return parts.join('\n\n');
  }

  /** Check if text has compound task structure (multiple actions). */
  private hasCompoundStructure(text: string): boolean {
    let matches = 0;
    for (const pattern of COMPOUND_PATTERNS) {
      if (pattern.test(text)) matches++;
    }
    // Require at least 2 compound indicators, or 3+ sentences
    const sentenceCount = text.split(/[.!?]+/).filter(s => s.trim().length > 10).length;
    return matches >= 2 || sentenceCount >= 4;
  }

  /** Fallback: return a single sub-task covering the whole task. */
  private fallbackPlan(task: Task): DecompositionPlan {
    return {
      subTasks: [{
        id: generateId('subtask'),
        description: task.description,
        parentTaskId: task.id,
        dependsOn: [],
        budgetShare: 1.0,
      }],
      strategy: 'sequential',
      aggregation: 'Direct result',
    };
  }

  /** Topological sort sub-tasks by dependency order. */
  private topologicalSort(subTasks: SubTaskDefinition[]): SubTaskDefinition[] {
    const visited = new Set<string>();
    const result: SubTaskDefinition[] = [];
    const taskMap = new Map(subTasks.map(st => [st.id, st]));

    const visit = (task: SubTaskDefinition) => {
      if (visited.has(task.id)) return;
      visited.add(task.id);

      for (const depId of task.dependsOn) {
        const dep = taskMap.get(depId);
        if (dep) visit(dep);
      }

      result.push(task);
    };

    for (const task of subTasks) {
      visit(task);
    }

    return result;
  }

  /** Enrich sub-task description with results from completed dependencies. */
  private enrichWithDependencyResults(
    description: string,
    depResults: TaskResult[],
  ): string {
    if (depResults.length === 0) return description;

    const context = depResults
      .map((r, i) => `Previous result ${i + 1}: ${(r.result ?? 'completed').slice(0, 300)}`)
      .join('\n');

    return `${description}\n\n[Context from prior sub-tasks]\n${context}`;
  }
}
