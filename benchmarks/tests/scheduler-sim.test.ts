import { describe, it, expect } from 'vitest';
import type { AgentLifecycleEvent, AgentLifecycleState } from '@joule/shared';
import { phasesFromEvents, recordsToAgents } from '../scheduler-sim/trace-to-phases.js';
import { simulate } from '../scheduler-sim/simulator.js';
import { compare } from '../scheduler-sim/metrics.js';
import type { SimAgent, SimPhaseKind } from '../scheduler-sim/types.js';
import type { AgentLifecycleRecord } from '../lifecycle/types.js';

// ── Builders ────────────────────────────────────────────────────────

function agent(
  agentId: string,
  workflowId: string,
  phases: Array<[SimPhaseKind, number]>,
  observedStartOffsetMs = 0,
): SimAgent {
  const total = phases.reduce((s, [, d]) => s + d, 0);
  return {
    workflowId,
    agentId,
    phases: phases.map(([kind, durationMs]) => ({ kind, durationMs })),
    observedStartOffsetMs,
    observedEndOffsetMs: observedStartOffsetMs + total,
  };
}

const sim = (agents: SimAgent[], o: Partial<Parameters<typeof simulate>[1]> = {}) =>
  simulate(agents, { policy: 'immediate', modelCapacity: 1, toolCapacity: 1, ...o });

// ── Trace conversion ────────────────────────────────────────────────

describe('trace to phases', () => {
  const ev = (from: AgentLifecycleState, to: AgentLifecycleState, timestamp: number): AgentLifecycleEvent =>
    ({ taskId: 't', agentId: 'a', from, to, timestamp });

  it('turns consecutive events into measured phases and stops at a terminal state', () => {
    const events = [
      ev('ready', 'model_running', 100),
      ev('model_running', 'ready', 400),
      ev('ready', 'tool_wait', 400),
      ev('tool_wait', 'ready', 1400),
      ev('ready', 'completed', 1450),
    ];
    expect(phasesFromEvents(events)).toEqual([
      { kind: 'model', durationMs: 300 },
      { kind: 'tool', durationMs: 1000 },
      { kind: 'other', durationMs: 50 },
    ]);
  });

  it('groups agents by workflow and keeps their observed offsets', () => {
    const record = (agentId: string, start: number): AgentLifecycleRecord => ({
      runId: 'r', taskId: `task-${agentId}`, parentTaskId: 'w1', agentId,
      executionMode: 'direct', status: 'completed', success: true,
      totalRuntimeMs: 200, modelRuntimeMs: 100, toolWaitMs: 100, otherMs: 0, idleFraction: 0.5,
      modelCalls: 1, toolCalls: 1, avgToolWaitMs: 100, p95ToolWaitMs: 100, maxToolWaitMs: 100, minToolWaitMs: 100,
      toolWaitDurationsMs: [100],
      lifecycleEvents: [
        ev('ready', 'model_running', start),
        ev('model_running', 'ready', start + 100),
        ev('ready', 'tool_wait', start + 100),
        ev('tool_wait', 'ready', start + 200),
        ev('ready', 'completed', start + 200),
      ],
    });

    const agents = recordsToAgents([record('a', 1000), record('b', 1500)]);
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ agentId: 'a', workflowId: 'w1', observedStartOffsetMs: 0 });
    expect(agents[1]).toMatchObject({ agentId: 'b', observedStartOffsetMs: 500 });
    expect(agents[0].phases.map(p => p.kind)).toEqual(['model', 'tool']);
  });
});

// ── Core scheduling behaviour ───────────────────────────────────────

describe('simulator', () => {
  it('1. runs a single agent model -> tool -> model', () => {
    const r = sim([agent('a', 'w1', [['model', 100], ['tool', 200], ['model', 100]])]);
    expect(r.makespanMs).toBe(400);
    expect(r.meanJctMs).toBe(400);
    expect(r.modelUtilization).toBeCloseTo(0.5, 6);
    expect(r.zeroModelDemandMs).toBe(200);
    expect(r.avgModelDemand).toBeCloseTo(0.5, 6);
  });

  it('2. keeps perfectly synchronized tool phases synchronized', () => {
    const agents = [
      agent('a', 'w1', [['model', 100], ['tool', 200]]),
      agent('b', 'w1', [['model', 100], ['tool', 200]]),
    ];
    const r = sim(agents, { modelCapacity: 2, toolCapacity: 2 });
    expect(r.makespanMs).toBe(300);
    expect(r.allAgentsToolWaitFraction).toBeCloseTo(200 / 300, 6);
    expect(r.synchronizedToolWaitFraction).toBeCloseTo(200 / 300, 6);
    expect(r.zeroModelDemandMs).toBe(200);
  });

  it('3. overlaps model and tool work when phases are staggered', () => {
    const agents = [
      agent('a', 'w1', [['model', 100], ['tool', 200]]),
      agent('b', 'w1', [['model', 100], ['tool', 200]]),
    ];
    const r = sim(agents, { policy: 'stagger', staggerMs: 100, modelCapacity: 1, toolCapacity: 2 });
    // a: model 0-100, tool 100-300. b: admitted at 100, model 100-200, tool 200-400.
    expect(r.makespanMs).toBe(400);
    expect(r.zeroModelDemandMs).toBe(200);
    // Both in tool over 200-300, and from 300 b is the only agent left and is
    // still in tool — "every active agent" is true then too.
    expect(r.allAgentsToolWaitFraction).toBeCloseTo(200 / 400, 6);
    // While a is in tool and b is computing, only half the agents wait.
    expect(r.synchronizedToolWaitFraction).toBeCloseTo(300 / 400, 6);
  });

  it('4. backfill pulls another workflow forward into idle model capacity', () => {
    const agents = [
      agent('a', 'w1', [['model', 100], ['tool', 300]], 0),
      agent('b', 'w2', [['model', 100]], 400),
    ];
    const baseline = sim(agents, { policy: 'observed', modelCapacity: 1, toolCapacity: 2 });
    const filled = sim(agents, { policy: 'backfill', modelCapacity: 1, toolCapacity: 2 });

    expect(baseline.makespanMs).toBe(500);
    expect(baseline.zeroModelDemandMs).toBe(300);
    expect(filled.makespanMs).toBe(400);
    expect(filled.zeroModelDemandMs).toBe(200);
    expect(compare(baseline, filled).deltaMakespanPct).toBeLessThan(0);
  });

  it('5. serializes model phases at modelCapacity 1 and records the queue wait', () => {
    const agents = [agent('a', 'w1', [['model', 100]]), agent('b', 'w1', [['model', 100]])];
    const r = sim(agents, { modelCapacity: 1 });
    expect(r.makespanMs).toBe(200);
    expect(r.modelQueue.p95Ms).toBe(100);
    expect(r.modelQueue.meanMs).toBe(50);
    expect(r.modelQueue.waits).toBe(1);
  });

  it('6. runs model phases in parallel at modelCapacity 2', () => {
    const agents = [agent('a', 'w1', [['model', 100]]), agent('b', 'w1', [['model', 100]])];
    const r = sim(agents, { modelCapacity: 2 });
    expect(r.makespanMs).toBe(100);
    expect(r.modelQueue.totalMs).toBe(0);
    expect(r.maxModelDemand).toBe(2);
  });

  it('7. serializes tool phases at toolCapacity 1', () => {
    const agents = [agent('a', 'w1', [['tool', 100]]), agent('b', 'w1', [['tool', 100]])];
    const r = sim(agents, { toolCapacity: 1 });
    expect(r.makespanMs).toBe(200);
    expect(r.toolQueue.p95Ms).toBe(100);
    expect(r.toolSaturationFraction).toBeCloseTo(1, 6);
  });

  it('8. runs tool phases in parallel at toolCapacity 4', () => {
    const agents = [agent('a', 'w1', [['tool', 100]]), agent('b', 'w1', [['tool', 100]])];
    const r = sim(agents, { toolCapacity: 4 });
    expect(r.makespanMs).toBe(100);
    expect(r.maxToolDemand).toBe(2);
    expect(r.toolSaturationMs).toBe(0);
  });

  it('9. counts synchronized tool wait only above half the active agents', () => {
    // One of four agents in a tool phase is 25% — not synchronized.
    const quarter = sim([
      agent('a', 'w1', [['tool', 100]]),
      agent('b', 'w1', [['model', 100]]),
      agent('c', 'w1', [['model', 100]]),
      agent('d', 'w1', [['model', 100]]),
    ], { modelCapacity: 4, toolCapacity: 4 });
    expect(quarter.synchronizedToolWaitFraction).toBe(0);

    // Two of four is 50% — synchronized.
    const half = sim([
      agent('a', 'w1', [['tool', 100]]),
      agent('b', 'w1', [['tool', 100]]),
      agent('c', 'w1', [['model', 100]]),
      agent('d', 'w1', [['model', 100]]),
    ], { modelCapacity: 4, toolCapacity: 4 });
    expect(half.synchronizedToolWaitFraction).toBeCloseTo(1, 6);
    expect(half.allAgentsToolWaitFraction).toBe(0);
  });

  it('10. counts all-agents tool wait only when nobody is computing', () => {
    const r = sim([
      agent('a', 'w1', [['tool', 100], ['model', 100]]),
      agent('b', 'w1', [['tool', 100], ['model', 100]]),
    ], { modelCapacity: 2, toolCapacity: 2 });
    // Both in tool 0-100, both in model 100-200.
    expect(r.allAgentsToolWaitFraction).toBeCloseTo(0.5, 6);
    expect(r.zeroModelDemandMs).toBe(100);
  });

  it('11. applies fixed stagger offsets per workflow', () => {
    const agents = [
      agent('a', 'w1', [['model', 100]]),
      agent('b', 'w1', [['model', 100]]),
      agent('c', 'w1', [['model', 100]]),
    ];
    const r = sim(agents, { policy: 'stagger', staggerMs: 50, modelCapacity: 3 });
    expect(r.makespanMs).toBe(200);
    expect(r.maxModelDemand).toBe(2);
  });

  it('12. is deterministic: the oracle gives identical results across runs', () => {
    const agents = [
      agent('a', 'w1', [['model', 120], ['tool', 300], ['model', 90]]),
      agent('b', 'w1', [['model', 80], ['tool', 500]]),
      agent('c', 'w2', [['model', 200], ['tool', 100], ['model', 50]]),
    ];
    const first = sim(agents, { policy: 'oracle', modelCapacity: 1, toolCapacity: 2 });
    const second = sim(agents, { policy: 'oracle', modelCapacity: 1, toolCapacity: 2 });
    expect(first).toEqual(second);
  });

  it('13. reports per-workflow completion and JCT', () => {
    const agents = [
      agent('a', 'w1', [['model', 100]]),
      agent('b', 'w2', [['model', 100], ['tool', 100]]),
    ];
    const r = sim(agents, { modelCapacity: 2, toolCapacity: 2 });
    expect(r.workflows).toBe(2);
    expect(r.workflows_.find(w => w.workflowId === 'w1')?.jctMs).toBe(100);
    expect(r.workflows_.find(w => w.workflowId === 'w2')?.jctMs).toBe(200);
    expect(r.meanJctMs).toBe(150);
    expect(r.makespanMs).toBe(200);
  });

  it('14. leaves durations untouched with the contention model off', () => {
    const agents = [agent('a', 'w1', [['tool', 100]]), agent('b', 'w1', [['tool', 100]])];
    const r = sim(agents, { toolCapacity: 2, contention: false });
    expect(r.makespanMs).toBe(100);
  });

  it('15. stretches tool durations with the contention model on', () => {
    const agents = [agent('a', 'w1', [['tool', 100]]), agent('b', 'w1', [['tool', 100]])];
    const r = sim(agents, { toolCapacity: 2, contention: true });
    // The second phase to start sees concurrency 2 -> x1.15; the first is unstretched.
    expect(r.makespanMs).toBeCloseTo(115, 6);

    const custom = sim(agents, { toolCapacity: 2, contention: true, slowdown: c => (c >= 2 ? 2 : 1) });
    expect(custom.makespanMs).toBeCloseTo(200, 6);
  });
});
