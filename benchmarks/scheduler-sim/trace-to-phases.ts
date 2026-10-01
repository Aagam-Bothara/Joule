/**
 * Lifecycle records -> simulator input.
 *
 * A trace already describes the agent as a sequence of states with timestamps,
 * so the phases come straight out of it: the agent is in the state an event
 * entered until the next event, and that gap is the phase duration. Nothing is
 * invented or rescaled.
 */

import type { AgentLifecycleEvent, AgentLifecycleState } from '@joule/shared';
import { activeInterval } from '../lifecycle/record.js';
import { groupByWorkflow } from '../lifecycle/analyze.js';
import type { AgentLifecycleRecord } from '../lifecycle/types.js';
import type { SimAgent, SimPhase, SimPhaseKind } from './types.js';

const TERMINAL: ReadonlySet<AgentLifecycleState> = new Set(['completed', 'failed', 'cancelled']);

function kindOf(state: AgentLifecycleState): SimPhaseKind {
  if (state === 'model_running') return 'model';
  if (state === 'tool_wait') return 'tool';
  return 'other';
}

/** Phases of one agent, oldest first. Terminal states end the sequence. */
export function phasesFromEvents(events: readonly AgentLifecycleEvent[]): SimPhase[] {
  const phases: SimPhase[] = [];
  for (let i = 0; i < events.length - 1; i++) {
    const state = events[i].to;
    if (TERMINAL.has(state)) break;
    const durationMs = Math.max(0, events[i + 1].timestamp - events[i].timestamp);
    if (durationMs > 0) phases.push({ kind: kindOf(state), durationMs });
  }
  return phases;
}

/**
 * Agents grouped by workflow, with each agent's observed offset inside its
 * workflow preserved so the baseline can replay what actually happened.
 * Agents whose trace yields no phases are dropped.
 */
export function recordsToAgents(records: readonly AgentLifecycleRecord[]): SimAgent[] {
  const out: SimAgent[] = [];
  for (const group of groupByWorkflow(records).values()) {
    const spans = group
      .map(r => ({ record: r, span: activeInterval(r.lifecycleEvents) }))
      .filter((x): x is { record: AgentLifecycleRecord; span: { start: number; end: number } } => x.span !== undefined);
    if (spans.length === 0) continue;
    const workflowStart = Math.min(...spans.map(s => s.span.start));

    for (const { record, span } of spans) {
      const phases = phasesFromEvents(record.lifecycleEvents);
      if (phases.length === 0) continue;
      out.push({
        workflowId: record.parentTaskId ?? record.taskId,
        agentId: record.agentId,
        ...(record.agentRole ? { agentRole: record.agentRole } : {}),
        phases,
        observedStartOffsetMs: span.start - workflowStart,
        observedEndOffsetMs: span.end - workflowStart,
      });
    }
  }
  // Stable order: workflow, then observed start, then id — the simulator's
  // tie-breaking depends on it, so results stay reproducible.
  return out.sort((a, b) =>
    a.workflowId.localeCompare(b.workflowId)
    || a.observedStartOffsetMs - b.observedStartOffsetMs
    || a.agentId.localeCompare(b.agentId));
}
