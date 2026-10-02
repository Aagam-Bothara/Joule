/**
 * Turning one crew run into experiment records.
 *
 * Kept apart from the runner so the extraction can be tested without starting
 * a runtime, and so the rules for what an artifact keeps live in one place.
 *
 * What a row has to be able to answer, after the fact, about every agent:
 * did it execute, did it fail, why, at what stage, and which tools it used.
 * Datasets E and E2 could answer none of these for the fifteen agents that
 * made zero model calls.
 */

import type { AgentResult } from '@joule/shared';
import { failureStage, modelHostCounts, sanitizeAnswer, sanitizeFailure, toolCallSequence } from '../lifecycle/record.js';
import type { AgentContribution, CrewScalingRecord } from './types.js';

/** Sum several per-key counts; undefined when there is nothing to count. */
export function mergeCounts(all: ReadonlyArray<Record<string, number> | undefined>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const counts of all) {
    for (const [key, n] of Object.entries(counts ?? {})) out[key] = (out[key] ?? 0) + n;
  }
  return Object.keys(out).length > 0
    ? Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
    : undefined;
}

/**
 * A crew run's billed cost and serving hosts, from its agents. Fields are
 * absent when no agent reported them, so "not reported" never reads as zero.
 */
export function crewBilling(
  contributions: readonly AgentContribution[],
): Pick<CrewScalingRecord, 'totalBilledCostUsd' | 'billedModelCalls' | 'modelHosts'> {
  const billed = contributions.filter(c => typeof c.billedCostUsd === 'number');
  const hosts = mergeCounts(contributions.map(c => c.modelHosts));
  return {
    ...(billed.length > 0 ? {
      totalBilledCostUsd: billed.reduce((s, c) => s + (c.billedCostUsd ?? 0), 0),
      billedModelCalls: billed.reduce((s, c) => s + (c.billedModelCalls ?? 0), 0),
    } : {}),
    ...(hosts ? { modelHosts: hosts } : {}),
  };
}

/**
 * Billed-cost totals for a manifest, next to the estimate it sits beside. The
 * call counts say how much of the run the billed figure covers.
 */
export function manifestBilling(records: readonly CrewScalingRecord[]): {
  totalBilledCostUsd: number | null;
  billedModelCalls: number;
  modelCalls: number;
  modelHosts: Record<string, number>;
} {
  const billed = records.filter(r => typeof r.totalBilledCostUsd === 'number');
  return {
    totalBilledCostUsd: billed.length > 0 ? billed.reduce((s, r) => s + (r.totalBilledCostUsd ?? 0), 0) : null,
    billedModelCalls: records.reduce((s, r) => s + (r.billedModelCalls ?? 0), 0),
    modelCalls: records.reduce((s, r) => s + (r.modelCalls ?? 0), 0),
    modelHosts: mergeCounts(records.map(r => r.modelHosts)) ?? {},
  };
}

/**
 * Input/output token split over the agents that reported one; absent when
 * none did, so "not recorded" never reads as zero. Measurement only.
 */
export function tokenSplit(contributions: readonly AgentContribution[]): Pick<CrewScalingRecord, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'> {
  const split = contributions.filter(c => typeof c.promptTokens === 'number' || typeof c.completionTokens === 'number');
  if (split.length === 0) return {};
  return {
    inputTokens: split.reduce((s, c) => s + (c.promptTokens ?? 0), 0),
    outputTokens: split.reduce((s, c) => s + (c.completionTokens ?? 0), 0),
    cachedInputTokens: split.reduce((s, c) => s + (c.cachedPromptTokens ?? 0), 0),
  };
}

/** Per-agent work, from the lifecycle instrumentation the result already carries. */
export function contributionOf(agentResult: AgentResult): AgentContribution {
  const result = agentResult.taskResult;
  const metrics = result.lifecycleMetrics;
  const edits = result.verifiedEdits;
  const events = result.lifecycle ?? [];
  const error = sanitizeFailure(result.error);
  const stage = failureStage(events);
  const tools = toolCallSequence(events);

  const answer = sanitizeAnswer(result.result);
  const hosts = modelHostCounts(events);

  return {
    ...(edits ? {
      proposedWrites: edits.proposed,
      acceptedWrites: edits.accepted,
      rolledBackWrites: edits.rollbacks,
      ...(edits.restoreFailures ? { restoreFailedWrites: edits.restoreFailures } : {}),
      ...(edits.verified !== undefined ? { verified: edits.verified } : {}),
    } : {}),
    agentId: agentResult.agentId,
    role: agentResult.role,
    success: result.status === 'completed',
    status: result.status,
    ...(error ? { error } : {}),
    ...(stage ? { failedFrom: stage } : {}),
    costUsd: agentResult.budgetUsed?.costUsd,
    ...(typeof result.billedCostUsd === 'number' ? { billedCostUsd: result.billedCostUsd } : {}),
    ...(typeof result.billedModelCalls === 'number' ? { billedModelCalls: result.billedModelCalls } : {}),
    ...(hosts ? { modelHosts: hosts } : {}),
    tokens: agentResult.budgetUsed?.tokensUsed,
    ...(typeof result.promptTokens === 'number' ? { promptTokens: result.promptTokens } : {}),
    ...(typeof result.completionTokens === 'number' ? { completionTokens: result.completionTokens } : {}),
    ...(typeof result.cachedPromptTokens === 'number' ? { cachedPromptTokens: result.cachedPromptTokens } : {}),
    modelCalls: metrics?.modelCalls ?? 0,
    toolCalls: metrics?.toolCalls ?? 0,
    ...(tools.length > 0 ? { tools } : {}),
    ...(answer ? { answer } : {}),
  };
}
