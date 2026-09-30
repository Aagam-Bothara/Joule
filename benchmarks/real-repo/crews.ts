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
 * between them is unaffected — it is the comparison with the earlier datasets
 * that carries the caveat.
 */

import type { AgentDefinition, CrewDefinition } from '@joule/shared';
import type { ComparisonArm } from '../specialist-value/crews.js';

const TOOLS = ['repo_read', 'repo_write', 'repo_edit', 'repo_shell'];
const PRIMARY_ITERATIONS = 16;
// The smoke runs hit 10 while still inspecting pytest/pylint. Match the
// primary's 16 turns; the existing 100k-token and 10-minute caps still bound
// each recovery attempt.
const RECOVERY_ITERATIONS = 16;
const STAGE_WALL_TIMEOUT_MS = 600_000;

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
  maxRetries: 0,
};

export function sweCrew(arm: ComparisonArm): CrewDefinition {
  const base = {
    budget: 'high' as const,
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
