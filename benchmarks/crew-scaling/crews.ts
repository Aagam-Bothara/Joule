/**
 * Crew composition by width.
 *
 * Each width is a superset of the one below it, so widening a crew adds a role
 * rather than swapping the team out. The composition is fixed for every task —
 * no per-task tuning — and the pipeline runs `sequential`, because a reviewer
 * or tester only has something to do once the implementer has produced code.
 *
 *   1: implementer
 *   2: implementer, reviewer
 *   3: implementer, reviewer, tester
 *   4: researcher, implementer, reviewer, tester
 *
 * The researcher is added last: with these tasks the implementer already reads
 * the problem statement, so a separate research step is the least obviously
 * useful role and belongs at the widest setting.
 */

import type { AgentDefinition, CrewDefinition } from '@joule/shared';
import type { CrewWidth } from './types.js';

const IMPLEMENTER: AgentDefinition = {
  id: 'implementer',
  role: 'Implementer',
  instructions:
    'You write the solution. Use file_write to create solution.py in the task directory, implementing exactly the function the task names. '
    + 'Then run `python run_tests.py` in that directory with shell_exec and report the output. If tests fail, fix solution.py and run them again. Do not edit run_tests.py.',
  allowedTools: ['file_write', 'file_read', 'shell_exec'],
  // Enough turns to write the file and iterate once or twice: a tighter cap
  // would make width 1 fail for lack of turns rather than lack of agents.
  maxIterations: 10,
  maxRetries: 0,
};

const REVIEWER: AgentDefinition = {
  id: 'reviewer',
  role: 'Reviewer',
  instructions:
    'You review the implementer\'s solution. Use file_read on solution.py in the task directory and check it against the task description and the asserts in run_tests.py. '
    + 'If you find a defect, fix it with file_write and re-run `python run_tests.py` with shell_exec. If it is already correct, say so briefly. Do not edit run_tests.py.',
  allowedTools: ['file_read', 'file_write', 'shell_exec'],
  maxIterations: 6,
  maxRetries: 0,
};

const TESTER: AgentDefinition = {
  id: 'tester',
  role: 'Tester',
  instructions:
    'You verify the solution by running it. Use shell_exec to run `python run_tests.py` in the task directory and report the exact output. '
    + 'If it fails, read solution.py, fix the defect with file_write, and run the tests again. Do not edit run_tests.py.',
  allowedTools: ['shell_exec', 'file_read', 'file_write'],
  maxIterations: 6,
  maxRetries: 0,
};

const RESEARCHER: AgentDefinition = {
  id: 'researcher',
  role: 'Researcher',
  instructions:
    'You prepare the work for the implementer. Use file_read on run_tests.py in the task directory to see exactly what the asserts require, '
    + 'then state the function signature and the edge cases in at most 5 bullet points. Do not write solution.py yourself.',
  allowedTools: ['file_read', 'shell_exec'],
  maxIterations: 4,
  maxRetries: 0,
};

/** Roles in execution order for each width. */
export const ROLES_BY_WIDTH: Record<CrewWidth, AgentDefinition[]> = {
  1: [IMPLEMENTER],
  2: [IMPLEMENTER, REVIEWER],
  3: [IMPLEMENTER, REVIEWER, TESTER],
  4: [RESEARCHER, IMPLEMENTER, REVIEWER, TESTER],
};

/**
 * Every agent is given the same budget at every width.
 *
 * Under the default share-based allocation the crew budget is divided among
 * the agents, so the implementer ran on ~100k tokens at width 1 but ~33k at
 * width 3 — and several implementer failures in datasets E and E2 sit right at
 * that 33k line. Crew width would then be two variables at once: how many
 * agents there are, and how much the one that writes the code is allowed to
 * spend. `fixed_per_agent` separates them; the crew envelope still records the
 * group's total spending, it just no longer caps any member.
 */
export function crewForWidth(width: CrewWidth): CrewDefinition {
  const agents = ROLES_BY_WIDTH[width];
  return {
    name: `crew-width-${width}`,
    description: `Fixed crew of ${agents.length} for the crew-scaling experiment`,
    strategy: 'sequential',
    agents: agents.map(a => ({ ...a })),
    budget: 'high',
    budgetMode: 'fixed_per_agent',
    aggregation: 'last',
  };
}

export function roleNames(width: CrewWidth): string[] {
  return ROLES_BY_WIDTH[width].map(a => a.id);
}
