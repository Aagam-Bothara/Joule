/**
 * Deterministic discrete-event simulator over measured lifecycle phases.
 *
 * Time advances only to the next event (a phase ending, or an agent becoming
 * eligible), so every metric is integrated exactly rather than sampled. The
 * simulator never invents durations: it replays the measured ones under a
 * different schedule and a configurable resource capacity.
 */

import { percentile } from '../lifecycle/analyze.js';
import { POLICIES, defaultSlowdown, type RuntimeAgent } from './policies.js';
import type { QueueStats, SimAgent, SimConfig, SimMetrics, SimPhaseKind, WorkflowResult } from './types.js';

interface Waits { model: number[]; tool: number[] }

function queueStats(values: readonly number[]): QueueStats {
  const waited = values.filter(v => v > 0);
  return {
    meanMs: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0,
    p95Ms: percentile(values, 0.95),
    totalMs: values.reduce((a, b) => a + b, 0),
    waits: waited.length,
  };
}

/**
 * Where an admitted agent would be at `atMs` if nothing queued it — used by the
 * oracle admission gates, which are allowed to look ahead.
 */
function projectedKindAt(runtime: RuntimeAgent, nowMs: number, atMs: number): SimPhaseKind | undefined {
  if (runtime.state === 'done' || runtime.state === 'pending') return undefined;
  const phases = runtime.agent.phases;
  let cursor = runtime.state === 'running' ? (runtime.phaseEndMs ?? nowMs) : nowMs;
  if (runtime.state === 'running') {
    if (atMs < cursor) return phases[runtime.phaseIndex]?.kind;
  }
  for (let i = runtime.phaseIndex + (runtime.state === 'running' ? 1 : 0); i < phases.length; i++) {
    const end = cursor + phases[i].durationMs;
    if (atMs < end) return phases[i].kind;
    cursor = end;
  }
  return undefined;
}

export function simulate(agents: readonly SimAgent[], config: SimConfig): SimMetrics {
  const policy = POLICIES[config.policy];
  const slowdown = config.contention ? (config.slowdown ?? defaultSlowdown) : undefined;

  // Index inside the workflow drives the stagger policy.
  const seenPerWorkflow = new Map<string, number>();
  const runtime: RuntimeAgent[] = agents.map(agent => {
    const index = seenPerWorkflow.get(agent.workflowId) ?? 0;
    seenPerWorkflow.set(agent.workflowId, index + 1);
    return {
      agent,
      phaseIndex: 0,
      state: 'pending' as const,
      nextKind: agent.phases[0]?.kind,
      remainingMs: agent.phases.reduce((s, p) => s + p.durationMs, 0),
      eligibleAtMs: policy.eligibleAtMs(agent, index, config),
    } as RuntimeAgent & { eligibleAtMs: number };
  });
  const eligibleAt = new Map<RuntimeAgent, number>(
    runtime.map(r => [r, (r as RuntimeAgent & { eligibleAtMs: number }).eligibleAtMs]),
  );
  const readySince = new Map<RuntimeAgent, number>();
  const waits: Waits = { model: [], tool: [] };
  const completedAt = new Map<RuntimeAgent, number>();

  let modelInUse = 0;
  let toolInUse = 0;
  let nowMs = 0;

  // Integrated metrics.
  let modelBusyMs = 0;
  let toolBusyMs = 0;
  let modelWeighted = 0;
  let toolWeighted = 0;
  let maxModelDemand = 0;
  let maxToolDemand = 0;
  let zeroModelDemandMs = 0;
  let toolSaturationMs = 0;
  let syncToolMs = 0;
  let allToolMs = 0;

  const admit = (): void => {
    for (const candidate of runtime) {
      if (candidate.state !== 'pending') continue;
      if ((eligibleAt.get(candidate) ?? 0) > nowMs) continue;
      const allowed = policy.canAdmit?.({
        nowMs,
        candidate,
        all: runtime,
        config,
        modelInUse,
        toolInUse,
        projectedToolAt: (atMs: number) =>
          runtime.filter(r => r !== candidate && projectedKindAt(r, nowMs, atMs) === 'tool').length,
      }) ?? true;
      if (!allowed) continue;
      candidate.state = 'waiting';
      candidate.admittedAtMs = nowMs;
      readySince.set(candidate, nowMs);
    }
  };

  const dispatch = (): void => {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const waiting = runtime.filter(r => r.state === 'waiting');
      if (policy.priority) waiting.sort(policy.priority);
      else waiting.sort((a, b) => (a.admittedAtMs ?? 0) - (b.admittedAtMs ?? 0) || a.agent.agentId.localeCompare(b.agent.agentId));

      for (const r of waiting) {
        const phase = r.agent.phases[r.phaseIndex];
        if (!phase) continue;
        if (phase.kind === 'model' && modelInUse >= config.modelCapacity) continue;
        if (phase.kind === 'tool' && toolInUse >= config.toolCapacity) continue;

        const queued = nowMs - (readySince.get(r) ?? nowMs);
        if (phase.kind === 'model') waits.model.push(queued);
        if (phase.kind === 'tool') waits.tool.push(queued);

        let duration = phase.durationMs;
        if (phase.kind === 'tool' && slowdown) duration *= slowdown(toolInUse + 1);

        r.state = 'running';
        r.phaseEndMs = nowMs + duration;
        if (phase.kind === 'model') modelInUse++;
        if (phase.kind === 'tool') toolInUse++;
        progressed = true;
      }
    }
  };

  const finishAt = (t: number): void => {
    for (const r of runtime) {
      if (r.state !== 'running' || (r.phaseEndMs ?? Infinity) > t) continue;
      const phase = r.agent.phases[r.phaseIndex];
      if (phase.kind === 'model') modelInUse--;
      if (phase.kind === 'tool') toolInUse--;
      r.remainingMs = Math.max(0, r.remainingMs - phase.durationMs);
      r.phaseIndex++;
      const next = r.agent.phases[r.phaseIndex];
      if (!next) {
        r.state = 'done';
        r.nextKind = undefined;
        completedAt.set(r, t);
      } else {
        r.state = 'waiting';
        r.nextKind = next.kind;
        readySince.set(r, t);
      }
    }
  };

  // Guard against a policy that can never admit anything.
  let guard = 0;
  const limit = 50 * (runtime.length + runtime.reduce((s, r) => s + r.agent.phases.length, 0)) + 10_000;

  while (runtime.some(r => r.state !== 'done') && guard++ < limit) {
    admit();
    dispatch();

    // An admission gate must never stall the run: with nothing executing and
    // nobody admissible, the earliest pending agent is admitted anyway.
    if (!runtime.some(r => r.state === 'running')) {
      const pending = runtime.filter(r => r.state === 'pending');
      if (pending.length > 0) {
        const soonest = Math.min(...pending.map(r => Math.max(eligibleAt.get(r) ?? 0, nowMs)));
        if (soonest > nowMs) {
          nowMs = soonest;
          continue;
        }
        const next = pending.find(r => (eligibleAt.get(r) ?? 0) <= nowMs);
        if (next) {
          next.state = 'waiting';
          next.admittedAtMs = nowMs;
          readySince.set(next, nowMs);
          continue;
        }
      } else if (!runtime.some(r => r.state === 'waiting')) {
        break;
      }
    }

    const ends = runtime.filter(r => r.state === 'running').map(r => r.phaseEndMs ?? Infinity);
    // Only genuinely future eligibility creates an event; agents held back by a
    // policy gate are reconsidered when the next phase completes.
    const eligibles = runtime
      .filter(r => r.state === 'pending' && (eligibleAt.get(r) ?? 0) > nowMs)
      .map(r => eligibleAt.get(r) ?? 0);
    const next = Math.min(...ends, ...eligibles);
    if (!Number.isFinite(next)) break;

    // Integrate over [nowMs, next).
    const dt = next - nowMs;
    if (dt > 0) {
      const active = runtime.filter(r => r.state === 'waiting' || r.state === 'running').length;
      const toolRunning = runtime.filter(r => r.state === 'running' && r.agent.phases[r.phaseIndex].kind === 'tool').length;
      modelBusyMs += Math.min(modelInUse, config.modelCapacity) * dt;
      toolBusyMs += Math.min(toolInUse, config.toolCapacity) * dt;
      modelWeighted += modelInUse * dt;
      toolWeighted += toolInUse * dt;
      maxModelDemand = Math.max(maxModelDemand, modelInUse);
      maxToolDemand = Math.max(maxToolDemand, toolInUse);
      if (modelInUse === 0 && active > 0) zeroModelDemandMs += dt;
      if (toolInUse >= config.toolCapacity) toolSaturationMs += dt;
      if (active > 0 && toolRunning >= Math.ceil(active / 2)) syncToolMs += dt;
      if (active > 0 && toolRunning === active) allToolMs += dt;
    }

    nowMs = next;
    finishAt(nowMs);
  }

  const makespanMs = Math.max(0, ...[...completedAt.values()]);
  const byWorkflow = new Map<string, number[]>();
  for (const [r, at] of completedAt) {
    const list = byWorkflow.get(r.agent.workflowId) ?? [];
    list.push(at);
    byWorkflow.set(r.agent.workflowId, list);
  }
  const workflows_: WorkflowResult[] = [...byWorkflow.entries()]
    .map(([workflowId, times]) => ({ workflowId, agents: times.length, jctMs: Math.max(...times) }))
    .sort((a, b) => a.workflowId.localeCompare(b.workflowId));
  const jcts = workflows_.map(w => w.jctMs);

  return {
    policy: config.policy,
    modelCapacity: config.modelCapacity,
    toolCapacity: config.toolCapacity,
    contention: Boolean(config.contention),
    agents: runtime.length,
    workflows: workflows_.length,
    meanJctMs: jcts.length > 0 ? jcts.reduce((a, b) => a + b, 0) / jcts.length : 0,
    medianJctMs: percentile(jcts, 0.5),
    p95JctMs: percentile(jcts, 0.95),
    makespanMs,
    avgModelDemand: makespanMs > 0 ? modelWeighted / makespanMs : 0,
    maxModelDemand,
    modelUtilization: makespanMs > 0 ? modelBusyMs / (config.modelCapacity * makespanMs) : 0,
    zeroModelDemandMs,
    zeroModelDemandFraction: makespanMs > 0 ? zeroModelDemandMs / makespanMs : 0,
    avgToolDemand: makespanMs > 0 ? toolWeighted / makespanMs : 0,
    maxToolDemand,
    toolSaturationMs,
    toolSaturationFraction: makespanMs > 0 ? toolSaturationMs / makespanMs : 0,
    modelQueue: queueStats(waits.model),
    toolQueue: queueStats(waits.tool),
    synchronizedToolWaitFraction: makespanMs > 0 ? syncToolMs / makespanMs : 0,
    allAgentsToolWaitFraction: makespanMs > 0 ? allToolMs / makespanMs : 0,
    workflows_,
  };
}
