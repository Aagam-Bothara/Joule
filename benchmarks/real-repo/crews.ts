/**
 * The comparison crews, ported to a real repository's tool surface.
 *
 * The authored fixtures gave agents `file_read`, `file_write` and `shell_exec`
 * on the host. A SWE-bench instance lives inside its own container, so the
 * tools are `repo_read`, `repo_write`, `repo_edit` and `repo_shell` instead.
 * The roles are otherwise carried over word for word: same responsibility, same
 * adversarial framing for the recovery stages, same wall-clock ceilings and
 * budget mode. Recovery has 16 iterations because the 10-iteration authored
 * fixture limit ended real-repository inspection mid-task.
 *
 * This is a port, not a rewrite, and it is worth being explicit that it is not
 * a null change: the prompts name different tools than the authored-fixture
 * runs did. Both arms get exactly the same definitions, so the comparison
 * between them is unaffected â€” it is the comparison with the earlier datasets
 * that carries the caveat.
 */

import type { AgentDefinition, BudgetEnvelope, CrewDefinition } from '@joule/shared';
import type { ComparisonArm } from '../specialist-value/crews.js';

const TOOLS = ['repo_read', 'repo_write', 'repo_edit', 'repo_shell'];

/**
 * The escalation harness's SWE-bench allowance, per agent: 30 turns, 30
 * minutes, 1.5M tokens (harness/workloads/swebench.ts). Same model, same
 * container tools; the ladder resolved 44 of 95 instances with it.
 *
 * History, each step decided before the run it governed:
 * - `high` (100k tokens, 16 turns, 10 min): all 13 pool tasks ran out of tokens
 *   after 6-11 calls, still reading (real-repo-primary-baseline-v2).
 * - 400k tokens, `high` x4 otherwise: 11 of 13 hit the 16-turn cap, one edit in
 *   all 13 (real-repo-primary-baseline-400k).
 * - plus a 12k output cap per reply (it had been the provider's 1024): 4 of 13
 *   resolved, 6 still hit the 16-turn cap (real-repo-primary-out12k-c).
 * - now the ladder's turns, time and tokens together, so that raising one does
 *   not make another the new binding limit.
 *
 * Cost keeps its $1 ceiling. Written out rather than derived from a preset so
 * the recorded values cannot drift.
 */
export const REAL_REPO_BUDGET: BudgetEnvelope = {
  maxTokens: 1_500_000, // high: 100_000
  maxToolCalls: 160, // high: 40
  maxLatencyMs: 1_800_000, // high: 300_000; matches the agents' wall clock below
  maxEscalations: 5,
  costCeilingUsd: 1.0,
  maxEnergyWh: 2.0, // high: 0.5
  maxCarbonGrams: 0.8, // high: 0.2
};
const PRIMARY_ITERATIONS = 30;
const RECOVERY_ITERATIONS = 30;
const STAGE_WALL_TIMEOUT_MS = 1_800_000;
// The escalation harness's SWE-bench setting (harness/workloads/swebench.ts).
// Before 2026-10-01 these agents ran at the provider default of 1024, which
// cannot hold a real source file in one repo_write.
const OUTPUT_TOKENS = 12_000;

const PRIMARY: AgentDefinition = {
  id: 'implementer',
  role: 'Implementer',
  instructions:
    'You fix the repository so that its verification passes. Read the files you need with repo_read, work out why '
    + 'the reported issue happens, and correct the source with repo_edit or repo_write. Then run the relevant tests '
    + 'with repo_shell and report what they printed. Do not modify the test files, and do not change what the tests assert.',
  allowedTools: TOOLS,
  maxIterations: PRIMARY_ITERATIONS,
  wallTimeoutMs: STAGE_WALL_TIMEOUT_MS,
  maxOutputTokens: OUTPUT_TOKENS,
  maxRetries: 0,
};

const RECOVERY_REVIEWER: AgentDefinition = {
  id: 'reviewer',
  role: 'Reviewer',
  instructions:
    'The previous agent believes the task is complete, but external verification shows the repository is still '
    + 'failing. Assume there may be a concrete defect in the current implementation. Inspect the repository with '
    + 'repo_read and repo_shell, read the failing verification evidence and the reported issue, and actively identify '
    + 'the specific cause of the failure. If you identify a fix, modify the repository with repo_edit or repo_write '
    + 'and verify it with repo_shell. Do not merely describe the problem if you can safely fix it. Do not modify the '
    + 'test files.',
  allowedTools: TOOLS,
  maxIterations: RECOVERY_ITERATIONS,
  wallTimeoutMs: STAGE_WALL_TIMEOUT_MS,
  maxOutputTokens: OUTPUT_TOKENS,
  maxRetries: 0,
};

const RECOVERY_TESTER: AgentDefinition = {
  id: 'tester',
  role: 'Tester',
  instructions:
    'The primary implementation and the reviewer recovery attempt have both failed external verification. Use the '
    + 'current failing evidence to isolate the remaining defect: run the relevant tests and commands with repo_shell, '
    + 'inspect the affected source with repo_read, and repair the repository with repo_edit or repo_write when there '
    + 'is a concrete fix. Do not modify the test files.',
  allowedTools: TOOLS,
  maxIterations: RECOVERY_ITERATIONS,
  wallTimeoutMs: STAGE_WALL_TIMEOUT_MS,
  maxOutputTokens: OUTPUT_TOKENS,
  maxRetries: 0,
};

export function sweCrew(arm: ComparisonArm): CrewDefinition {
  const base = {
    budget: REAL_REPO_BUDGET,
    budgetMode: 'fixed_per_agent' as const,
    aggregation: 'last' as const,
    agents: [PRIMARY, RECOVERY_REVIEWER, RECOVERY_TESTER],
  };
  if (arm === 'primary') {
    return { ...base, name: 'rr-primary', description: 'Implementer alone', strategy: 'sequential', agents: [PRIMARY] };
  }
  if (arm === 'full') {
    return { ...base, name: 'rr-full', description: 'All three, every time, no verification between stages', strategy: 'sequential' };
  }
  if (arm === 'full_verify') {
    return { ...base, name: 'rr-full-verify', description: 'All three, every time, verified and handed on between stages', strategy: 'verified_full' };
  }
  return { ...base, name: 'rr-staged', description: 'Escalating only where verification fails', strategy: 'staged_recovery' };
}
