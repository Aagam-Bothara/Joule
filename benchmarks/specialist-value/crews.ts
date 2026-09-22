/**
 * Dataset F crews.
 *
 * The roles, instructions and tools are Dataset E's, used verbatim — this
 * experiment is not about rewriting prompts. What changes are the ceilings:
 * E's caps were sized for "write one function", and on a diagnose-and-fix task
 * the implementer ran out of turns while still reading, with one run ending on
 * the five-minute wall clock. Failures would then have measured the cap rather
 * than the crew.
 *
 * The ceilings move for every arm equally, and Dataset E's own definitions are
 * left untouched so that dataset stays reproducible.
 */

import type { AgentDefinition, CrewDefinition } from '@joule/shared';
import { crewForWidth } from '../crew-scaling/crews.js';
import { ARM_WIDTH, type Arm } from './tasks.js';

// ── Repository-generic contracts for the staged-recovery comparison ──
//
// Dataset E's contracts named `solution.py`, which exists in no repository
// here. These say the same things about responsibility without naming a file,
// and they keep the framing the measurement supports: the recovery roles are
// told to assume a concrete defect exists and to fix it, not to comment on it.
// The three arms below share these definitions, so a comparison between them is
// a comparison of strategies and nothing else.

const TOOLS = ['file_read', 'file_write', 'shell_exec'];
const PRIMARY_ITERATIONS = 16;
const RECOVERY_ITERATIONS = 10;
const STAGE_WALL_TIMEOUT_MS = 600_000;

const PRIMARY: AgentDefinition = {
  id: 'implementer',
  role: 'Implementer',
  instructions:
    'You fix the repository so that its verification command passes. Read the files you need, work out why it is '
    + 'failing, and correct the source with file_write. Then run the verification command with shell_exec and report '
    + 'what it printed. Do not modify the test files, and do not change what the tests assert.',
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
    + 'failing. Assume there may be a concrete defect in the current implementation. Inspect the repository, the '
    + 'failing verification evidence and the task requirements, and actively identify the specific cause of the '
    + 'failure. If you identify a fix, modify the repository with file_write and verify it with shell_exec. Do not '
    + 'merely describe the problem if you can safely fix it. Do not modify the test files.',
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
    + 'current failing evidence to isolate the remaining defect: run the relevant tests and commands with shell_exec, '
    + 'inspect the affected source with file_read, and repair the repository with file_write when there is a concrete '
    + 'fix. Do not modify the test files.',
  allowedTools: TOOLS,
  maxIterations: RECOVERY_ITERATIONS,
  wallTimeoutMs: STAGE_WALL_TIMEOUT_MS,
  maxRetries: 0,
};

/** The three arms of the staged comparison. Same agents; only the strategy differs. */
export type ComparisonArm = 'primary' | 'full' | 'staged';

export const COMPARISON_ARMS: ComparisonArm[] = ['primary', 'full', 'staged'];

export function comparisonCrew(arm: ComparisonArm): CrewDefinition {
  const base = {
    budget: 'high' as const,
    budgetMode: 'fixed_per_agent' as const,
    aggregation: 'last' as const,
  };
  if (arm === 'primary') {
    return { ...base, name: 'arm-primary', description: 'Implementer alone', strategy: 'sequential', agents: [PRIMARY] };
  }
  if (arm === 'full') {
    return {
      ...base,
      name: 'arm-full',
      description: 'Implementer, then reviewer, then tester — every time',
      strategy: 'sequential',
      agents: [PRIMARY, RECOVERY_REVIEWER, RECOVERY_TESTER],
    };
  }
  return {
    ...base,
    name: 'arm-staged',
    description: 'Implementer, escalating only where verification fails',
    strategy: 'staged_recovery',
    agents: [PRIMARY, RECOVERY_REVIEWER, RECOVERY_TESTER],
  };
}

const IMPLEMENTER_ITERATIONS = 16;
const SPECIALIST_ITERATIONS = 10;
const WALL_TIMEOUT_MS = 600_000;

/**
 * The control for arm B: a second implementer instead of a reviewer.
 *
 * Arm B showed that adding a specialist recovers repositories the primary
 * abandoned. It cannot show whether that is the reviewer *role* or simply a
 * second agent starting fresh, because both changed at once. Here only the
 * second agent's instructions differ from arm B — same model, same tools, same
 * iteration and time limits, same position in the pipeline, same everything
 * else — so whatever difference appears is the role and nothing but.
 *
 * The role string stays "Implementer" because it is part of the prompt the
 * agent sees; the two are told apart by id.
 */
export function crewForControl(): CrewDefinition {
  const armB = crewForArm('B');
  const primary = armB.agents[0];
  return {
    ...armB,
    name: 'arm-B-control',
    description: 'Dataset F control: implementer + a second implementer',
    agents: [
      primary,
      {
        ...primary,
        id: 'implementer-2',
        // Matched to the reviewer's ceiling, not the primary's, so the second
        // seat is worth the same in either arm.
        maxIterations: armB.agents[1].maxIterations,
      },
    ],
  };
}

export function crewForArm(arm: Arm): CrewDefinition {
  const base = crewForWidth(ARM_WIDTH[arm]);
  return {
    ...base,
    name: `arm-${arm}`,
    description: `Dataset F arm ${arm}: ${base.agents.map(a => a.id).join(' + ')}`,
    agents: base.agents.map(a => ({
      ...a,
      maxIterations: a.id === 'implementer' ? IMPLEMENTER_ITERATIONS : SPECIALIST_ITERATIONS,
      wallTimeoutMs: WALL_TIMEOUT_MS,
    })),
  };
}
