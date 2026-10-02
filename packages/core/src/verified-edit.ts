/**
 * Verified-edit gate.
 *
 * An agent that edits a file another agent already got working can turn a
 * passing state into a failing one. Measured on crew runs: four of twenty-seven
 * width steps lost a solved task purely to a later agent's write-back.
 *
 * The gate answers two questions about shared state, and nothing more:
 *
 *   - what state is currently verified?   (`baseline`: the last check that passed)
 *   - should this write be kept?          (re-run the check; restore if it regressed)
 *
 * Files are read and restored through the policy's `workspace`: the host
 * filesystem by default, or whatever the harness supplies when its write tools
 * act elsewhere (the real-repository harness edits files inside a container).
 *
 * It is opt-in: without a policy on the task, nothing here runs and behaviour is
 * unchanged. It deliberately does not merge patches, track provenance or resolve
 * conflicts — no experiment has produced conflict data to design those against.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { EditWorkspace, VerifiedEditPolicy } from '@joule/shared';
import type { TraceLogger } from './trace-logger.js';

/**
 * The host filesystem, read and written as the gate always has.
 *
 * This is the default. A policy names another workspace only when its write
 * tools act somewhere the host path would not reach, such as a repository
 * inside a container.
 */
export const hostEditWorkspace: EditWorkspace = {
  read: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  write: (path, content) => writeFileSync(path, content),
  remove: path => {
    if (existsSync(path)) unlinkSync(path);
  },
};

/** Outcome of running the policy's check command. */
export interface CheckResult {
  passed: boolean;
  output: string;
}

/** What the gate did during a run. */
export interface VerifiedEditStats {
  checks: number;
  rollbacks: number;
  /** Regressions the gate tried to undo but could not; never counted as rollbacks */
  restoreFailures: number;
  /** Writes the gate reviewed */
  proposed: number;
  /** Writes that left the workspace verifying */
  accepted: number;
  /** accepted / proposed */
  acceptanceRate: number;
  verified: boolean | undefined;
  byAuthor: Record<string, { proposed: number; accepted: number; rolledBack: number }>;
}

export interface EditDecision {
  /** Whether the write was kept */
  kept: boolean;
  /** Set when a passing state was restored after a regression */
  rolledBack: boolean;
  /** What the agent should be told; empty when the write was fine */
  message: string;
}

/**
 * Files an argument object might name.
 *
 * These keys must cover every alias the write tools accept: a write the gate
 * cannot see a path in is a write it cannot snapshot, so it would be executed
 * unprotected and counted as no proposal at all. `filepath` is one the
 * `file_write` tool normalizes and this list originally missed.
 */
function pathsIn(input: Record<string, unknown>): string[] {
  const keys = ['path', 'filePath', 'filepath', 'file_path', 'filename', 'file'];
  return keys
    .map(k => input[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function runCommand(command: string, cwd: string | undefined, timeoutMs: number): Promise<CheckResult> {
  return new Promise(resolve => {
    execFile(
      process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
      process.platform === 'win32' ? ['-NoProfile', '-Command', command] : ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim().slice(-2000);
        resolve({ passed: !error, output });
      },
    );
  });
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run a policy's check against the workspace as it stands.
 *
 * This is the same command, shell and timeout handling the gate uses, exported
 * so a caller can ask "is the workspace passing right now?" without owning a
 * gate. Staged recovery needs exactly that between agents: whether to escalate
 * has to be decided by the check, not by an agent reporting that it finished.
 */
export function runVerification(
  policy: VerifiedEditPolicy,
  run: (command: string, cwd: string | undefined, timeoutMs: number) => Promise<CheckResult> = runCommand,
): Promise<CheckResult> {
  return run(policy.command, policy.cwd, policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export class VerifiedEditGate {
  /** Whether the check has ever passed; undefined means "not established yet" */
  private baselinePassed: boolean | undefined;
  private rollbacks = 0;
  private restoreFailures = 0;
  private checks = 0;
  private proposed = 0;
  private accepted = 0;
  /** Per author (tool, or agent role when the caller supplies one) */
  private readonly byAuthor = new Map<string, { proposed: number; accepted: number; rolledBack: number }>();

  constructor(
    private readonly policy: VerifiedEditPolicy,
    private readonly tracer?: TraceLogger,
    private readonly traceId?: string,
    private readonly run: (command: string, cwd: string | undefined, timeoutMs: number) => Promise<CheckResult> = runCommand,
  ) {}

  /**
   * Activity is not contribution: Dataset E2 showed agents working hard and
   * making the result worse. These counts separate a proposed modification
   * from one that survived verification.
   */
  get stats(): VerifiedEditStats {
    return {
      checks: this.checks,
      rollbacks: this.rollbacks,
      restoreFailures: this.restoreFailures,
      proposed: this.proposed,
      accepted: this.accepted,
      acceptanceRate: this.proposed > 0 ? this.accepted / this.proposed : 0,
      verified: this.baselinePassed,
      byAuthor: Object.fromEntries([...this.byAuthor.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  /** Does this tool call modify files the gate should protect? */
  guards(toolName: string, input: Record<string, unknown>): boolean {
    const tools = this.policy.tools ?? ['file_write', 'file_edit', 'repo_write', 'repo_edit'];
    return tools.includes(toolName) && pathsIn(input).length > 0;
  }

  /** Where guarded files are read from and restored to. */
  private get workspace(): EditWorkspace {
    return this.policy.workspace ?? hostEditWorkspace;
  }

  /** Contents of the files this call will touch, so they can be put back. */
  snapshot(input: Record<string, unknown>): Map<string, string | null> {
    const before = new Map<string, string | null>();
    for (const path of pathsIn(input)) {
      before.set(path, this.workspace.read(path));
    }
    return before;
  }

  /**
   * Run the check after a write. A failure only rolls the write back when the
   * state was known to be passing beforehand: while a task has never passed,
   * an agent is still working towards the first success and must be allowed to
   * leave it broken.
   */
  async review(snapshot: Map<string, string | null>, toolName: string, author = toolName): Promise<EditDecision> {
    this.proposed++;
    const tally = this.byAuthor.get(author) ?? { proposed: 0, accepted: 0, rolledBack: 0 };
    tally.proposed++;
    this.byAuthor.set(author, tally);
    const result = await this.run(this.policy.command, this.policy.cwd, this.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.checks++;

    if (result.passed) {
      this.baselinePassed = true;
      this.accepted++;
      tally.accepted++;
      this.log('verified_edit_ok', { toolName, author, checks: this.checks });
      return { kept: true, rolledBack: false, message: '' };
    }

    if (this.baselinePassed !== true) {
      // Nothing verified to protect yet.
      // Kept, but it did not verify: not an accepted contribution.
      this.log('verified_edit_failed', { toolName, author, rolledBack: false, output: result.output.slice(0, 400) });
      return {
        kept: true,
        rolledBack: false,
        message: `${this.verificationName} did not pass after this edit: ${result.output.slice(-400)}`,
      };
    }

    // Put every file back, and know which ones did not go back: a write that
    // could not be undone must never be reported, to the agent or in the
    // counts, as rolled back.
    const unrestored: string[] = [];
    for (const [path, content] of snapshot) {
      try {
        if (content === null) {
          this.workspace.remove(path);
        } else {
          this.workspace.write(path, content);
        }
      } catch (err) {
        unrestored.push(`${path} (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    if (unrestored.length > 0) {
      this.restoreFailures++;
      // The verified state is no longer in the workspace, so there is nothing
      // to protect until a check passes again: further writes are the repair.
      this.baselinePassed = false;
      this.log('verified_edit_restore_failed', { toolName, author, unrestored, output: result.output.slice(0, 400) });
      return {
        kept: true,
        rolledBack: false,
        message:
          `Your edit turned a passing state into a failing one, and restoring the previous version FAILED for `
          + `${unrestored.join('; ')}. Your change is still in place and the workspace is failing: repair or undo it. `
          + `${this.outputName}: ${result.output.slice(-400)}`,
      };
    }

    this.rollbacks++;
    tally.rolledBack++;
    this.log('verified_edit_rolled_back', { toolName, author, rollbacks: this.rollbacks, output: result.output.slice(0, 400) });

    return {
      kept: false,
      rolledBack: true,
      message:
        `Your edit was rolled back: it turned a passing state into a failing one. `
        + `The previous working version has been restored. ${this.outputName}: ${result.output.slice(-400)}`,
    };
  }

  /**
   * How messages name the check. A policy label replaces the generic wording,
   * so the agent is told which check judged its edit without being shown the
   * command; the check's output is reported the same either way.
   */
  private get verificationName(): string {
    return this.policy.label ? `Verification (${this.policy.label})` : 'Verification';
  }

  private get outputName(): string {
    return this.policy.label ? `Output of ${this.policy.label}` : 'Check output';
  }

  /** Establish whether the workspace is passing before any edits happen. */
  async establishBaseline(): Promise<boolean> {
    const result = await this.run(this.policy.command, this.policy.cwd, this.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.checks++;
    this.baselinePassed = result.passed;
    this.log('verified_edit_baseline', { passed: result.passed });
    return result.passed;
  }

  private log(type: string, data: Record<string, unknown>): void {
    if (!this.tracer || !this.traceId) return;
    this.tracer.logEvent(this.traceId, 'info', { type, ...data });
  }
}
