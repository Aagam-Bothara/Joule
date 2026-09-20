/**
 * Trace-driven scheduling simulation — types.
 *
 * Offline only: this consumes lifecycle traces Joule already produced and asks
 * what a different schedule would have done with the same measured phases.
 * Nothing here runs agents, and no policy implemented here exists in Joule.
 *
 * Resources are deliberately generic. `model` is one inference slot and `tool`
 * is one external-work slot; neither implies a particular piece of hardware.
 */

export type SimPhaseKind = 'model' | 'tool' | 'other';

/** One measured phase from a trace. Durations are never synthesized. */
export interface SimPhase {
  kind: SimPhaseKind;
  durationMs: number;
}

export interface SimAgent {
  workflowId: string;
  agentId: string;
  agentRole?: string;
  phases: SimPhase[];
  /** Where this agent started in the observed trace, relative to its workflow */
  observedStartOffsetMs: number;
  /** Where it finished in the observed trace, relative to its workflow */
  observedEndOffsetMs: number;
}

export type PolicyName =
  | 'observed'
  | 'immediate'
  | 'stagger'
  | 'model-aware'
  | 'tool-aware'
  | 'backfill'
  | 'oracle';

export interface SimConfig {
  /** Concurrent model phases allowed */
  modelCapacity: number;
  /** Concurrent tool phases allowed */
  toolCapacity: number;
  policy: PolicyName;
  /** Per-agent start offset for the `stagger` policy */
  staggerMs?: number;
  /**
   * Hypothetical tool slowdown under contention. OFF by default; the factors
   * are assumptions, not measurements, and every headline result is reported
   * with it off.
   */
  contention?: boolean;
  /** Multiplier applied to a tool phase given the number of concurrent tool phases */
  slowdown?: (concurrency: number) => number;
}

export interface QueueStats {
  meanMs: number;
  p95Ms: number;
  totalMs: number;
  /** Phases that had to wait at all */
  waits: number;
}

export interface WorkflowResult {
  workflowId: string;
  agents: number;
  /** Completion time of the workflow's last agent */
  jctMs: number;
}

export interface SimMetrics {
  policy: PolicyName;
  modelCapacity: number;
  toolCapacity: number;
  contention: boolean;

  agents: number;
  workflows: number;

  meanJctMs: number;
  medianJctMs: number;
  p95JctMs: number;
  makespanMs: number;

  /** Time-weighted mean of concurrent model phases */
  avgModelDemand: number;
  maxModelDemand: number;
  /** Busy model-slot time over capacity x makespan */
  modelUtilization: number;
  zeroModelDemandMs: number;
  zeroModelDemandFraction: number;

  avgToolDemand: number;
  maxToolDemand: number;
  toolSaturationMs: number;
  toolSaturationFraction: number;

  modelQueue: QueueStats;
  toolQueue: QueueStats;

  /** Time with at least half of the active agents in a tool phase */
  synchronizedToolWaitFraction: number;
  /** Time with every active agent in a tool phase */
  allAgentsToolWaitFraction: number;

  workflows_: WorkflowResult[];
}

/** One policy compared against the baseline. */
export interface PolicyComparison {
  policy: PolicyName;
  deltaMeanJctPct: number;
  deltaP95JctPct: number;
  deltaMakespanPct: number;
  deltaZeroModelDemandPct: number;
  deltaSyncToolWaitPct: number;
  deltaMeanJctMs: number;
  deltaMakespanMs: number;
}
