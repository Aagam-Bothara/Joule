import { describe, it, expect } from 'vitest';
import type { AgentLifecycleEvent, AgentLifecycleState } from '@joule/shared';
import { renderValidation, validateRecord, validateRecords } from '../lifecycle/validate.js';
import type { AgentLifecycleRecord } from '../lifecycle/types.js';

/** A well-formed record: model 0-100, tool 110-310, done at 320. */
function clean(overrides: Partial<AgentLifecycleRecord> = {}): AgentLifecycleRecord {
  const step = (from: AgentLifecycleState, to: AgentLifecycleState, timestamp: number): AgentLifecycleEvent =>
    ({ taskId: 'task-1', agentId: 'agent-1', from, to, timestamp });
  return {
    runId: 'run-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    executionMode: 'direct',
    status: 'completed',
    success: true,
    totalRuntimeMs: 320,
    modelRuntimeMs: 100,
    toolWaitMs: 200,
    otherMs: 20,
    idleFraction: 200 / 320,
    modelCalls: 1,
    toolCalls: 1,
    avgToolWaitMs: 200,
    p95ToolWaitMs: 200,
    maxToolWaitMs: 200,
    minToolWaitMs: 200,
    toolWaitDurationsMs: [200],
    lifecycleEvents: [
      step('ready', 'model_running', 0),
      step('model_running', 'ready', 100),
      step('ready', 'tool_wait', 110),
      step('tool_wait', 'ready', 310),
      step('ready', 'completed', 320),
    ],
    ...overrides,
  };
}

describe('record validation', () => {
  it('accepts a well-formed record', () => {
    expect(validateRecord(clean())).toEqual([]);
  });

  it('rejects a record with no events', () => {
    const issues = validateRecord(clean({ lifecycleEvents: [] }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'no_events' });
  });

  it('rejects a broken state chain, which is how impossible overlaps show up', () => {
    const record = clean();
    // Two states entered without leaving the first.
    record.lifecycleEvents[2] = { ...record.lifecycleEvents[2], from: 'model_running' };
    expect(validateRecord(record).map(i => i.code)).toContain('broken_state_chain');
  });

  it('rejects timestamps that move backwards', () => {
    const record = clean();
    record.lifecycleEvents[3] = { ...record.lifecycleEvents[3], timestamp: 50 };
    expect(validateRecord(record).map(i => i.code)).toContain('nonmonotonic_timestamps');
  });

  it('rejects a run that never reaches a terminal state', () => {
    const record = clean();
    record.lifecycleEvents = record.lifecycleEvents.slice(0, 4);
    expect(validateRecord(record).map(i => i.code)).toContain('no_terminal_state');
  });

  it('rejects a rollup that exceeds the run', () => {
    expect(validateRecord(clean({ modelRuntimeMs: 400 })).map(i => i.code)).toContain('metrics_exceed_runtime');
  });

  it('warns, but does not reject, when a run did no external work', () => {
    const issues = validateRecord(clean({ toolCalls: 0 }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'no_tool_calls' });

    const result = validateRecords([clean({ toolCalls: 0 })]);
    expect(result.ok).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('splits usable records from malformed ones and summarizes', () => {
    const result = validateRecords([clean(), clean({ lifecycleEvents: [] }), clean({ toolCalls: 0 })]);

    expect(result.ok).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);

    const rendered = renderValidation(result);
    expect(rendered).toContain('2 usable, 1 rejected');
    expect(rendered).toContain('no_events');
    expect(renderValidation({ ok: [], rejected: [], issues: [] })).toBe('Data quality: no issues.');
  });
});
