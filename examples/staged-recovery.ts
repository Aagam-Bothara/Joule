/**
 * Staged Recovery — escalate only when verification says the work is wrong
 *
 * An agent that reports success is not evidence that the task is done. This crew
 * runs an implementer, then runs the task's real check. If the check passes, the
 * reviewer and tester are never instantiated: no context is built, no model is
 * called, nothing is billed. If it fails, the next agent is handed the check's
 * command and its actual output and asked to find the defect.
 *
 * The verification command lives on the TASK rather than the crew, because it is
 * a property of the work: the same crew can be pointed at any repository that
 * knows how to check itself.
 *
 * Run: npx tsx examples/staged-recovery.ts
 */

import { Joule } from '@joule/core';
import { fileReadTool, fileWriteTool, shellExecTool } from '@joule/tools';
import type { AgentDefinition, CrewDefinition, Task } from '@joule/shared';

const TOOLS = ['file_read', 'file_write', 'shell_exec'];

/** Does the work. Sees the task, not a diagnosis. */
const implementer: AgentDefinition = {
  id: 'implementer',
  role: 'Implementer',
  instructions:
    'You fix the repository so that its verification command passes. Read the files you need, work out why it is '
    + 'failing, correct the source with file_write, then run the verification command and report what it printed. '
    + 'Do not modify the test files.',
  allowedTools: TOOLS,
  maxIterations: 16,
};

/**
 * Runs only if the check disagreed with the implementer.
 *
 * The framing is the part that earned its place: a second agent with the
 * implementer's own prompt inherits the implementer's belief that the work is
 * finished and never edits anything. This one is told to assume a defect exists.
 */
const reviewer: AgentDefinition = {
  id: 'reviewer',
  role: 'Reviewer',
  instructions:
    'The previous agent believes the task is complete, but external verification shows the repository is still '
    + 'failing. Assume there may be a concrete defect in the current implementation. Inspect the repository and the '
    + 'failing verification evidence, identify the specific cause, and fix it with file_write. Do not merely describe '
    + 'the problem if you can safely fix it. Do not modify the test files.',
  allowedTools: TOOLS,
  maxIterations: 10,
};

/** Last stage. Reached only when both earlier attempts failed the check. */
const tester: AgentDefinition = {
  id: 'tester',
  role: 'Tester',
  instructions:
    'The primary implementation and the reviewer recovery attempt have both failed external verification. Use the '
    + 'current failing evidence to isolate the remaining defect: run the relevant tests with shell_exec, inspect the '
    + 'affected source, and repair the repository when there is a concrete fix. Do not modify the test files.',
  allowedTools: TOOLS,
  maxIterations: 10,
};

async function main(): Promise<void> {
  const joule = new Joule();
  await joule.initialize();
  for (const tool of [fileReadTool, fileWriteTool, shellExecTool]) joule.registerTool(tool);

  const crew: CrewDefinition = {
    name: 'staged-debug',
    description: 'Implementer, escalating to recovery roles only where verification fails',
    // 'verified_full' runs every stage but still verifies between them — the
    // control used to separate the evidence effect from the skipping effect.
    strategy: 'staged_recovery',
    agents: [implementer, reviewer, tester],
    budget: 'high',
    // Each agent gets the full per-agent ceiling, so having recovery available
    // costs the implementer nothing.
    budgetMode: 'fixed_per_agent',
  };

  const repo = process.argv[2] ?? process.cwd();
  const task: Task = {
    id: 'fix-failing-suite',
    description: `The test suite in ${repo} fails. Find the cause in the source and fix it.`,
    createdAt: new Date().toISOString(),
    // The external check. Its exit code is the only thing that decides whether
    // the next stage runs — staged_recovery refuses to run without it.
    verifiedEdit: { command: 'npm test', cwd: repo, timeoutMs: 120_000 },
  };

  const result = await joule.executeCrew(crew, task);
  const staged = result.staged;

  console.log(`\nverified: ${staged?.verified}   status: ${result.status}`);
  console.log(`stages executed: ${staged?.stagesExecuted} of ${crew.agents.length}`);
  if (staged?.solvedAtStage !== undefined) {
    console.log(`solved at stage ${staged.solvedAtStage} by ${staged.solvedByRole}`);
  }

  for (const stage of staged?.stages ?? []) {
    if (!stage.executed) {
      // Not "ran and did nothing" — never started.
      console.log(`  ${stage.stage}. ${stage.role}: skipped (${stage.skipReason})`);
      continue;
    }
    console.log(
      `  ${stage.stage}. ${stage.role}: ${stage.modelCalls} model calls, ${stage.toolCalls} tool calls, `
      + `${stage.acceptedWrites ?? 0} accepted write(s), check ${stage.verification?.passed ? 'PASS' : 'FAIL'}`,
    );
  }

  await joule.shutdown();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
