/**
 * StepVerifier — independent of the agent's self-confidence.
 *
 * Deterministic kinds are preferred and run by default:
 *   output_check   regex / substring over the tool output
 *   dom_check      browser_evaluate script must be truthy
 *   command_exit   shell command exit code (tests, build, lint)
 *   test_result    command exit code AND output pattern
 *
 * `llm_judge` is opt-in and always reported with its kind so benchmarks can
 * separate judged results from deterministic ones.
 */

import type { StepResult, StepVerification } from '@joule/shared';
import type { ToolRegistry } from '../tool-registry.js';
import { stringifyOutput, truncate } from './execution-state.js';

export interface VerificationOutcome {
  passed: boolean;
  evidence: string;
  /** Which verifier produced this result ('none' when nothing ran) */
  kind: string;
  /** Fraction of checks that passed, when the output reported counts (e.g. "3/5 tests passed", "2 failed, 8 passed") */
  score?: number;
}

/**
 * Extract a pass fraction from test-runner style output. Understands
 * "X/Y tests passed", "N passed, M failed", "M failed, N passed", "N passed".
 * Returns undefined when nothing countable is present.
 */
export function parsePassFraction(output: string): number | undefined {
  const ratio = output.match(/(\d+)\s*\/\s*(\d+)\s+(?:tests?\s+)?passed/i);
  if (ratio) {
    const total = Number(ratio[2]);
    return total > 0 ? Math.min(1, Number(ratio[1]) / total) : undefined;
  }
  const passed = output.match(/(\d+)\s+passed/i);
  const failed = output.match(/(\d+)\s+failed/i);
  const errors = output.match(/(\d+)\s+errors?\b/i);
  if (!passed && !failed) return undefined;
  const p = passed ? Number(passed[1]) : 0;
  const f = (failed ? Number(failed[1]) : 0) + (errors ? Number(errors[1]) : 0);
  const total = p + f;
  return total > 0 ? p / total : undefined;
}

export type LlmJudge = (question: string) => Promise<{ passed: boolean; evidence: string }>;

export class StepVerifier {
  constructor(
    private tools: ToolRegistry,
    private options: { allowLlmJudge?: boolean; judge?: LlmJudge } = {},
  ) {}

  async verify(verify: StepVerification | undefined, result: StepResult): Promise<VerificationOutcome> {
    if (!verify || verify.type === 'none') {
      return this.autoVerify(result);
    }

    switch (verify.type) {
      case 'output_check':
        return { ...matchOutput(verify.assertion, stringifyOutput(result.output)), kind: 'output_check' };

      case 'dom_check':
        return this.domCheck(verify, result);

      case 'command_exit':
      case 'test_result':
        return this.commandCheck(verify);

      case 'llm_judge':
        if (!this.options.allowLlmJudge || !this.options.judge) {
          return this.autoVerify(result);
        }
        try {
          const judged = await this.options.judge(
            `Assertion: ${verify.assertion}\nTool: ${result.toolName}\nOutput: ${truncate(stringifyOutput(result.output), 1200)}`,
          );
          return { ...judged, kind: 'llm_judge' };
        } catch (err) {
          return { passed: false, evidence: `judge failed: ${errMsg(err)}`, kind: 'llm_judge' };
        }

      default:
        return this.autoVerify(result);
    }
  }

  /**
   * Cheap deterministic checks that need no declared assertion:
   * a command-shaped output with a non-zero exit code is a failure even if the
   * tool call itself "succeeded".
   */
  private autoVerify(result: StepResult): VerificationOutcome {
    const out = result.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
    if (result.success && out && typeof out === 'object' && typeof out.exitCode === 'number') {
      const passed = out.exitCode === 0;
      const combined = `${String(out.stdout ?? '')}\n${String(out.stderr ?? '')}`;
      const score = parsePassFraction(combined);
      return {
        passed,
        evidence: passed ? 'exit code 0' : `exit code ${out.exitCode}${out.stderr ? `: ${truncate(String(out.stderr), 200)}` : ''}`,
        kind: 'command_exit',
        score: passed ? 1 : score,
      };
    }
    return { passed: true, evidence: 'no verifier declared', kind: 'none' };
  }

  private async domCheck(verify: StepVerification, result: StepResult): Promise<VerificationOutcome> {
    if (this.tools.has('browser_evaluate')) {
      try {
        const evalResult = await this.tools.invoke({ toolName: 'browser_evaluate', input: { script: verify.assertion } });
        const passed = evalResult.success && Boolean(evalResult.output);
        return { passed, evidence: truncate(stringifyOutput(evalResult.output), 200), kind: 'dom_check' };
      } catch {
        // fall through to output check
      }
    }
    return { ...matchOutput(verify.assertion, stringifyOutput(result.output)), kind: 'output_check' };
  }

  private async commandCheck(verify: StepVerification): Promise<VerificationOutcome> {
    const kind = verify.type;
    if (!verify.command) {
      return { passed: false, evidence: `${kind} verification needs a command`, kind };
    }
    if (!this.tools.has('shell_exec')) {
      return { passed: false, evidence: 'shell_exec tool not registered', kind };
    }
    try {
      const res = await this.tools.invoke({
        toolName: 'shell_exec',
        input: { command: verify.command, ...(verify.cwd ? { cwd: verify.cwd } : {}) },
      });
      const out = (res.output ?? {}) as { stdout?: string; stderr?: string; exitCode?: number };
      const expected = verify.expectedExitCode ?? 0;
      const exitOk = res.success && out.exitCode === expected;
      const combined = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
      let passed = exitOk;
      let evidence = `exit ${out.exitCode ?? 'n/a'} (expected ${expected})`;
      if (kind === 'test_result' && verify.assertion) {
        const m = matchOutput(verify.assertion, combined);
        passed = passed && m.passed;
        evidence += `; ${m.evidence}`;
      }
      if (!passed && combined.trim()) evidence += `; ${truncate(combined.trim(), 300)}`;
      return { passed, evidence, kind, score: passed ? 1 : parsePassFraction(combined) };
    } catch (err) {
      return { passed: false, evidence: `command failed to run: ${errMsg(err)}`, kind };
    }
  }
}

export function matchOutput(assertion: string, output: string): { passed: boolean; evidence: string } {
  if (!assertion) return { passed: true, evidence: 'empty assertion' };
  try {
    const passed = new RegExp(assertion, 'i').test(output);
    return { passed, evidence: passed ? `output matches /${assertion}/` : `output does not match /${assertion}/` };
  } catch {
    const passed = output.toLowerCase().includes(assertion.toLowerCase());
    return { passed, evidence: passed ? `output contains "${assertion}"` : `output does not contain "${assertion}"` };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
