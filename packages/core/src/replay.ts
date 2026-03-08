/**
 * Execution Replay — re-run a past task with different parameters and diff the results.
 *
 * Loads the original task from SQLite, applies overrides (model, budget, governance),
 * re-executes, and computes a structured diff between original and replay results.
 */

import type { Task, BudgetPresetName, BudgetUsage } from '@joule/shared';
import { generateId } from '@joule/shared';
import type { Joule } from './engine.js';

export interface ReplayOptions {
  /** Task ID of the original execution to replay */
  originalTaskId: string;
  /** Overrides to apply for the replay */
  overrides?: {
    budget?: BudgetPresetName;
    governance?: boolean;
  };
}

export interface ReplayResult {
  original: {
    taskId: string;
    description: string;
    result: string;
    status: string;
    budgetUsed?: BudgetUsage;
    stepCount: number;
    toolsUsed: string[];
  };
  replay: {
    taskId: string;
    result: string;
    status: string;
    budgetUsed?: BudgetUsage;
    stepCount: number;
    toolsUsed: string[];
  };
  diff: ReplayDiff;
}

export interface ReplayDiff {
  /** Simple line-by-line diff of output text */
  outputChanged: boolean;
  outputDiff: string[];
  /** Budget comparison */
  budgetComparison: {
    originalTokens: number;
    replayTokens: number;
    originalCost: number;
    replayCost: number;
    tokenDelta: number;
    costDelta: number;
  };
  /** Step comparison */
  stepComparison: {
    originalStepCount: number;
    replayStepCount: number;
    toolsAdded: string[];
    toolsRemoved: string[];
  };
}

/**
 * Re-run a previous task with optional parameter overrides.
 */
export async function replayTask(joule: Joule, options: ReplayOptions): Promise<ReplayResult> {
  // Load original task data from SQLite
  if (!joule.store?.tasks) {
    throw new Error('Database not initialized — replay requires SQLite persistence');
  }

  const originalData = joule.store.tasks.getByIdParsed(options.originalTaskId);
  if (!originalData) {
    throw new Error(`Task not found: ${options.originalTaskId}`);
  }

  const originalDescription = String(originalData.description ?? options.originalTaskId);
  const originalResult = String(originalData.result ?? '');
  const originalStatus = String(originalData.status ?? 'unknown');
  const originalBudgetUsed = originalData.budgetUsed as BudgetUsage | undefined;
  const originalSteps = (originalData.stepResults as Array<{ toolName?: string; success?: boolean }>) ?? [];
  const originalTools = [...new Set(originalSteps.map(s => s.toolName).filter(Boolean))] as string[];

  // Create replay task
  const replayTaskObj: Task = {
    id: generateId('task'),
    description: originalDescription,
    budget: options.overrides?.budget ?? 'medium',
    createdAt: new Date().toISOString(),
  };

  // Execute replay
  const replayResult = await joule.execute(replayTaskObj);
  const replayTools = [...new Set(replayResult.stepResults.map(s => s.toolName))];

  // Compute diff
  const diff = computeDiff(
    { result: originalResult, budgetUsed: originalBudgetUsed, steps: originalSteps, tools: originalTools },
    { result: replayResult.result ?? '', budgetUsed: replayResult.budgetUsed, steps: replayResult.stepResults, tools: replayTools },
  );

  return {
    original: {
      taskId: options.originalTaskId,
      description: originalDescription,
      result: originalResult,
      status: originalStatus,
      budgetUsed: originalBudgetUsed,
      stepCount: originalSteps.length,
      toolsUsed: originalTools,
    },
    replay: {
      taskId: replayTaskObj.id,
      result: replayResult.result ?? '',
      status: replayResult.status,
      budgetUsed: replayResult.budgetUsed,
      stepCount: replayResult.stepResults.length,
      toolsUsed: replayTools,
    },
    diff,
  };
}

interface DiffInput {
  result: string;
  budgetUsed?: BudgetUsage;
  steps: Array<{ toolName?: string; success?: boolean }>;
  tools: string[];
}

/**
 * Compute a structured diff between two task executions.
 */
export function computeDiff(original: DiffInput, replay: DiffInput): ReplayDiff {
  // Simple line diff
  const origLines = original.result.split('\n');
  const replayLines = replay.result.split('\n');
  const outputDiff: string[] = [];
  const maxLines = Math.max(origLines.length, replayLines.length);

  for (let i = 0; i < maxLines; i++) {
    const origLine = origLines[i];
    const replayLine = replayLines[i];
    if (origLine === replayLine) {
      outputDiff.push(`  ${origLine ?? ''}`);
    } else {
      if (origLine !== undefined) outputDiff.push(`- ${origLine}`);
      if (replayLine !== undefined) outputDiff.push(`+ ${replayLine}`);
    }
  }

  const outputChanged = original.result !== replay.result;

  // Budget comparison
  const originalTokens = original.budgetUsed?.tokensUsed ?? 0;
  const replayTokens = replay.budgetUsed?.tokensUsed ?? 0;
  const originalCost = original.budgetUsed?.costUsd ?? 0;
  const replayCost = replay.budgetUsed?.costUsd ?? 0;

  // Step comparison
  const toolsAdded = replay.tools.filter(t => !original.tools.includes(t));
  const toolsRemoved = original.tools.filter(t => !replay.tools.includes(t));

  return {
    outputChanged,
    outputDiff,
    budgetComparison: {
      originalTokens,
      replayTokens,
      originalCost,
      replayCost,
      tokenDelta: replayTokens - originalTokens,
      costDelta: replayCost - originalCost,
    },
    stepComparison: {
      originalStepCount: original.steps.length,
      replayStepCount: replay.steps.length,
      toolsAdded,
      toolsRemoved,
    },
  };
}
