/**
 * Data-quality checks for lifecycle experiment records.
 *
 * A trace is only worth analyzing if its events form a consistent timeline:
 * states follow each other, timestamps move forward, the run reaches a terminal
 * state, and the rollup agrees with the events. Anything that fails is flagged
 * rather than silently averaged in.
 *
 * `no_tool_calls` is a warning, not an error: a run that never touched an
 * external tool is valid, but it carries no tool-wait evidence, which matters
 * when the whole point is characterizing waits.
 */

import type { AgentLifecycleRecord } from './types.js';
import { intervalsInState } from './record.js';

export type IssueCode =
  | 'no_events'
  | 'broken_state_chain'
  | 'nonmonotonic_timestamps'
  | 'negative_duration'
  | 'no_terminal_state'
  | 'metrics_exceed_runtime'
  | 'no_tool_calls'
  | 'no_model_calls';

export interface RecordIssue {
  severity: 'error' | 'warning';
  code: IssueCode;
  runId: string;
  agentId: string;
  taskId: string;
  detail: string;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
/** Rollups start a moment before the first event, so allow a small slack. */
const TOLERANCE_MS = 5;

export function validateRecord(record: AgentLifecycleRecord): RecordIssue[] {
  const issues: RecordIssue[] = [];
  const at = (severity: RecordIssue['severity'], code: IssueCode, detail: string): void => {
    issues.push({ severity, code, runId: record.runId, agentId: record.agentId, taskId: record.taskId, detail });
  };

  const events = record.lifecycleEvents;
  if (events.length === 0) {
    at('error', 'no_events', 'record carries no lifecycle events');
    return issues;
  }

  // Each transition must start where the previous one ended: one agent cannot
  // be in two states at once, so this also rules out overlapping intervals.
  for (let i = 1; i < events.length; i++) {
    if (events[i].from !== events[i - 1].to) {
      at('error', 'broken_state_chain', `event ${i} starts in ${events[i].from} after ${events[i - 1].to}`);
      break;
    }
  }

  for (let i = 1; i < events.length; i++) {
    if (events[i].timestamp < events[i - 1].timestamp) {
      at('error', 'nonmonotonic_timestamps', `event ${i} at ${events[i].timestamp} precedes ${events[i - 1].timestamp}`);
      break;
    }
  }

  for (const state of ['model_running', 'tool_wait'] as const) {
    if (intervalsInState(events, state).some(i => i.end < i.start)) {
      at('error', 'negative_duration', `${state} interval ends before it starts`);
    }
  }

  if (!TERMINAL.has(events[events.length - 1].to)) {
    at('error', 'no_terminal_state', `run ends in ${events[events.length - 1].to}`);
  }

  if (record.modelRuntimeMs + record.toolWaitMs > record.totalRuntimeMs + TOLERANCE_MS) {
    at('error', 'metrics_exceed_runtime', `model ${record.modelRuntimeMs}ms + tool ${record.toolWaitMs}ms > total ${record.totalRuntimeMs}ms`);
  }

  if (record.toolCalls === 0) at('warning', 'no_tool_calls', 'run made no external tool calls');
  if (record.modelCalls === 0) at('warning', 'no_model_calls', 'run made no model calls');

  return issues;
}

export interface ValidationResult {
  /** Records with no errors; warnings are kept in the dataset */
  ok: AgentLifecycleRecord[];
  /** Records with at least one error */
  rejected: AgentLifecycleRecord[];
  issues: RecordIssue[];
}

export function validateRecords(records: readonly AgentLifecycleRecord[]): ValidationResult {
  const ok: AgentLifecycleRecord[] = [];
  const rejected: AgentLifecycleRecord[] = [];
  const issues: RecordIssue[] = [];

  for (const record of records) {
    const found = validateRecord(record);
    issues.push(...found);
    if (found.some(i => i.severity === 'error')) rejected.push(record);
    else ok.push(record);
  }
  return { ok, rejected, issues };
}

/** One line per issue kind, for the CLI. */
export function renderValidation(result: ValidationResult): string {
  if (result.issues.length === 0) return 'Data quality: no issues.';
  const counts = new Map<string, number>();
  for (const issue of result.issues) {
    const key = `${issue.severity}:${issue.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [`Data quality: ${result.ok.length} usable, ${result.rejected.length} rejected`];
  for (const [key, count] of [...counts.entries()].sort()) {
    const [severity, code] = key.split(':');
    lines.push(`  ${severity === 'error' ? 'ERROR  ' : 'warning'} ${code.padEnd(24)} ${count}`);
  }
  const firstError = result.issues.find(i => i.severity === 'error');
  if (firstError) lines.push(`  first error: ${firstError.agentId} — ${firstError.detail}`);
  return lines.join('\n');
}
