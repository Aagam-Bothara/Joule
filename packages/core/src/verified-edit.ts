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
 * It is opt-in: without a policy on the task, nothing here runs and behaviour is
 * unchanged. It deliberately does not merge patches, track provenance or resolve
 * conflicts — no experiment has produced conflict data to design those against.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { VerifiedEditPolicy } from '@joule/shared';
import type { TraceLogger } from './trace-logger.js';

/** Outcome of running the policy's check command. */
export interface CheckResult {
  passed: boolean;
  output: string;
}

export interface EditDecision {
  /** Whether the write was kept */
  kept: boolean;
  /** Set when a passing state was restored after a regression */
  rolledBack: boolean;
  /** What the agent should be told; empty when the write was fine */
  message: string;
}

/** Files an argument object might name. */
function pathsIn(input: Record<string, unknown>): string[] {
  const keys = ['path', 'filePath', 'file_path', 'filename', 'file'];
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

export class VerifiedEditGate {
  /** Whether the check has ever passed; undefined means "not established yet" */
  private baselinePassed: boolean | undefined;
  private rollbacks = 0;
  private checks = 0;

  constructor(
    private readonly policy: VerifiedEditPolicy,
    private readonly tracer?: TraceLogger,
    private readonly traceId?: string,
    private readonly run: (command: string, cwd: string | undefined, timeoutMs: number) => Promise<CheckResult> = runCommand,
  ) {}

  get stats(): { checks: number; rollbacks: number; verified: boolean | undefined } {
    return { checks: this.checks, rollbacks: this.rollbacks, verified: this.baselinePassed };
  }

  /** Does this tool call modify files the gate should protect? */
  guards(toolName: string, input: Record<string, unknown>): boolean {
    const tools = this.policy.tools ?? ['file_write', 'file_edit', 'repo_write', 'repo_edit'];
    return tools.includes(toolName) && pathsIn(input).length > 0;
  }

  /** Contents of the files this call will touch, so they can be put back. */
  snapshot(input: Record<string, unknown>): Map<string, string | null> {
    const before = new Map<string, string | null>();
    for (const path of pathsIn(input)) {
      before.set(path, existsSync(path) ? readFileSync(path, 'utf8') : null);
    }
    return before;
  }

  /**
   * Run the check after a write. A failure only rolls the write back when the
   * state was known to be passing beforehand: while a task has never passed,
   * an agent is still working towards the first success and must be allowed to
   * leave it broken.
   */
  async review(snapshot: Map<string, string | null>, toolName: string): Promise<EditDecision> {
    const result = await this.run(this.policy.command, this.policy.cwd, this.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.checks++;

    if (result.passed) {
      this.baselinePassed = true;
      this.log('verified_edit_ok', { toolName, checks: this.checks });
      return { kept: true, rolledBack: false, message: '' };
    }

    if (this.baselinePassed !== true) {
      // Nothing verified to protect yet.
      this.log('verified_edit_failed', { toolName, rolledBack: false, output: result.output.slice(0, 400) });
      return {
        kept: true,
        rolledBack: false,
        message: `Verification did not pass after this edit: ${result.output.slice(-400)}`,
      };
    }

    for (const [path, content] of snapshot) {
      if (content === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        writeFileSync(path, content);
      }
    }
    this.rollbacks++;
    this.log('verified_edit_rolled_back', { toolName, rollbacks: this.rollbacks, output: result.output.slice(0, 400) });

    return {
      kept: false,
      rolledBack: true,
      message:
        `Your edit was rolled back: it turned a passing state into a failing one. `
        + `The previous working version has been restored. Check output: ${result.output.slice(-400)}`,
    };
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
