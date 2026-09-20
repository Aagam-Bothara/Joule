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
import { failureStage, sanitizeFailure, toolCallSequence } from '../lifecycle/record.js';
import type { AgentContribution } from './types.js';

/** Per-agent work, from the lifecycle instrumentation the result already carries. */
export function contributionOf(agentResult: AgentResult): AgentContribution {
  const result = agentResult.taskResult;
  const metrics = result.lifecycleMetrics;
  const edits = result.verifiedEdits;
  const events = result.lifecycle ?? [];
  const error = sanitizeFailure(result.error);
  const stage = failureStage(events);
  const tools = toolCallSequence(events);

  return {
    ...(edits ? {
      proposedWrites: edits.proposed,
      acceptedWrites: edits.accepted,
      rolledBackWrites: edits.rollbacks,
    } : {}),
    agentId: agentResult.agentId,
    role: agentResult.role,
    success: result.status === 'completed',
    status: result.status,
    ...(error ? { error } : {}),
    ...(stage ? { failedFrom: stage } : {}),
    costUsd: agentResult.budgetUsed?.costUsd,
    tokens: agentResult.budgetUsed?.tokensUsed,
    modelCalls: metrics?.modelCalls ?? 0,
    toolCalls: metrics?.toolCalls ?? 0,
    ...(tools.length > 0 ? { tools } : {}),
  };
}
