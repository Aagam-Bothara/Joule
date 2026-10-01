/**
 * Scheduling policies, all deterministic and all offline.
 *
 * Four of them (model-aware, tool-aware, backfill, oracle) use knowledge of
 * future phases that a live scheduler would not have. That is the point: they
 * bound what any online policy could achieve on these traces.
 */

import type { PolicyName, SimAgent, SimConfig, SimPhaseKind } from './types.js';

/** A simulated agent's live state, as the policies see it. */
export interface RuntimeAgent {
  agent: SimAgent;
  /** Index of the phase currently running or waiting to run */
  phaseIndex: number;
  state: 'pending' | 'waiting' | 'running' | 'done';
  /** Phase kind the agent needs next (undefined once done) */
  nextKind: SimPhaseKind | undefined;
  /** When the running phase ends */
  phaseEndMs?: number;
  admittedAtMs?: number;
  /** Remaining work across all unfinished phases */
  remainingMs: number;
}

export interface AdmissionContext {
  nowMs: number;
  candidate: RuntimeAgent;
  all: readonly RuntimeAgent[];
  config: SimConfig;
  modelInUse: number;
  toolInUse: number;
  /** Projected number of agents in a tool phase at `atMs`, ignoring future queueing */
  projectedToolAt(atMs: number): number;
}

export interface Policy {
  name: PolicyName;
  /** Earliest time the agent may be considered for admission */
  eligibleAtMs(agent: SimAgent, indexInWorkflow: number, config: SimConfig): number;
  /** Extra gate applied at every event time; omitted means "always" */
  canAdmit?(ctx: AdmissionContext): boolean;
  /** Ordering among waiting agents; lower sorts first. Omitted means admission order. */
  priority?(a: RuntimeAgent, b: RuntimeAgent): number;
}

const DEFAULT_STAGGER_MS = 500;

/** Nobody else is queued for a model slot right now. */
function modelQueueIdle(all: readonly RuntimeAgent[]): boolean {
  return !all.some(r => r.state === 'waiting' && r.nextKind === 'model');
}

/** First tool phase of an agent, and the model time that precedes it. */
function firstToolOffset(agent: SimAgent): number | undefined {
  let offset = 0;
  for (const phase of agent.phases) {
    if (phase.kind === 'tool') return offset;
    offset += phase.durationMs;
  }
  return undefined;
}

/**
 * `observed` — replay: each agent becomes eligible at the offset it actually
 * started at inside its workflow. Under unlimited capacity this reproduces the
 * trace exactly; under a capacity limit, phases queue.
 */
const observed: Policy = {
  name: 'observed',
  eligibleAtMs: agent => agent.observedStartOffsetMs,
};

/** `immediate` — everything is runnable at once; capacity decides the rest. */
const immediate: Policy = {
  name: 'immediate',
  eligibleAtMs: () => 0,
};

/** `stagger` — fixed offsets inside each workflow, the same rule everywhere. */
const stagger: Policy = {
  name: 'stagger',
  eligibleAtMs: (_agent, indexInWorkflow, config) => indexInWorkflow * (config.staggerMs ?? DEFAULT_STAGGER_MS),
};

/**
 * `model-aware` — admit only while inference capacity has slack: a new agent
 * joins when a model slot is free and nobody already admitted is queued for
 * one. Agents therefore enter as earlier agents drop into tool phases.
 */
const modelAware: Policy = {
  name: 'model-aware',
  eligibleAtMs: () => 0,
  canAdmit: ctx => ctx.modelInUse < ctx.config.modelCapacity && modelQueueIdle(ctx.all),
};

/**
 * `tool-aware` — admit only if the agent's first tool phase is projected to
 * land when tool capacity still has room, so admissions do not manufacture a
 * synchronized tool burst.
 */
const toolAware: Policy = {
  name: 'tool-aware',
  eligibleAtMs: () => 0,
  canAdmit: ctx => {
    if (ctx.toolInUse >= ctx.config.toolCapacity) return false;
    const offset = firstToolOffset(ctx.candidate.agent);
    if (offset === undefined) return true;
    return ctx.projectedToolAt(ctx.nowMs + offset) < ctx.config.toolCapacity;
  },
};

/**
 * `backfill` — keeps the observed offsets, but lets an agent start early when
 * a model slot would otherwise sit idle with nobody queued for it. This is the
 * "workflow A is waiting on a tool, give workflow B the slot" case.
 */
const backfill: Policy = {
  name: 'backfill',
  eligibleAtMs: () => 0,
  canAdmit: ctx =>
    ctx.nowMs >= ctx.candidate.agent.observedStartOffsetMs
    || (ctx.modelInUse < ctx.config.modelCapacity && modelQueueIdle(ctx.all)),
};

/**
 * `oracle` — the combined upper bound.
 *
 * It is work-conserving: an agent is withheld only when neither resource could
 * serve it right now, so the policy can never idle a slot that has work for it.
 * Its future knowledge shows up in the ordering — among waiting agents it runs
 * the one with the most work left (longest-processing-time first, the standard
 * makespan heuristic), which requires knowing every remaining phase.
 *
 * An earlier version gated admissions on model slack alone; that throttled
 * concurrency so much it lost to the baseline at higher capacities, which makes
 * for a useless bound. `model-aware` keeps that throttling behaviour so its
 * effect stays visible on its own.
 */
const oracle: Policy = {
  name: 'oracle',
  eligibleAtMs: () => 0,
  canAdmit: ctx => ctx.modelInUse < ctx.config.modelCapacity || ctx.toolInUse < ctx.config.toolCapacity,
  priority: (a, b) =>
    b.remainingMs - a.remainingMs || a.agent.agentId.localeCompare(b.agent.agentId),
};

export const POLICIES: Record<PolicyName, Policy> = {
  observed, immediate, stagger, 'model-aware': modelAware, 'tool-aware': toolAware, backfill, oracle,
};

export const POLICY_ORDER: PolicyName[] = ['observed', 'immediate', 'stagger', 'model-aware', 'tool-aware', 'backfill', 'oracle'];

/**
 * Hypothetical tool slowdown under contention. These factors are assumptions
 * for sensitivity analysis, not measurements, and the simulator runs with them
 * off unless asked.
 */
export function defaultSlowdown(concurrency: number): number {
  if (concurrency <= 1) return 1;
  if (concurrency === 2) return 1.15;
  if (concurrency === 3) return 1.35;
  return 1.6;
}
