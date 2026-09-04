/**
 * Trajectory reporting — the per-task record every mode emits.
 *
 * Built from the execution state plus the trace's tier rollup, or, for a
 * persisted trace, from the trace events alone.
 */

import {
  ModelTier,
  type EscalationDecision,
  type ExecutionMode,
  type ExecutionState,
  type ExecutionTrace,
  type TraceEvent,
  type TraceSpan,
  type TrajectoryConsult,
  type TrajectoryReport,
  type TrajectoryStep,
} from '@joule/shared';
import { computeTierUsage } from '../trace-logger.js';

export interface TrajectoryOptions {
  /** USD per token at the LLM tier, used when the run made no LLM calls */
  llmPricePerToken?: number;
  /** Human descriptions per agent turn (turns without a tool call) */
  stepDescriptions?: Record<number, string>;
}

export function buildTrajectoryReport(
  state: ExecutionState,
  trace: ExecutionTrace,
  status: string,
  opts: TrajectoryOptions = {},
): TrajectoryReport {
  const tier = trace.tierUsage ?? computeTierUsage(trace.spans);
  const stepsByIndex = new Map(state.completedSteps.map(s => [s.stepIndex, s]));
  const steps: TrajectoryStep[] = state.decisions.map(d => {
    const s = stepsByIndex.get(d.step);
    return {
      step: d.step,
      description: s?.description ?? opts.stepDescriptions?.[d.step] ?? describeDecision(d),
      toolName: s?.toolName,
      tier: d.tier,
      model: s?.model,
      success: s ? s.success : d.action !== 'abort',
      verified: s?.verified,
      action: d.action,
      confidence: d.score,
      reason: d.reason,
      consultId: s?.consultId ?? d.consultId,
    };
  });

  const consults: TrajectoryConsult[] = state.advice.map(a => ({
    consultId: a.consultId,
    step: a.step,
    model: a.model,
    tokens: a.tokens,
    costUsd: a.costUsd,
    question: a.question,
  }));

  return {
    taskId: state.taskId,
    mode: state.mode,
    success: status === 'completed',
    status,
    costUsd: round(trace.budget.used.costUsd, 6),
    estimatedLlmOnlyCostUsd: estimateLlmOnly(tier, opts.llmPricePerToken),
    latencyMs: Math.round(trace.totalDurationMs ?? 0),
    slmTokens: tier.slmTokens,
    midTokens: tier.midTokens,
    llmTokens: tier.llmTokens,
    consultations: state.consultations,
    handoffs: state.handoffs,
    handoffAtStep: state.handoffAtStep,
    toolCalls: trace.budget.used.toolCallsUsed,
    trajectoryLength: state.step,
    verifierKinds: [...new Set(state.completedSteps.map(s => s.verifierKind).filter((k): k is string => !!k && k !== 'none'))],
    steps,
    consults,
    decisions: state.decisions,
  };
}

/** Reconstruct a report from a persisted trace (e.g. `joule trace <id>`). */
export function buildTrajectoryFromTrace(trace: ExecutionTrace): TrajectoryReport | null {
  const events = collectEvents(trace.spans);
  const start = events.find(e => e.type === 'info' && e.data.type === 'adaptive_start');
  if (!start) return null;
  const end = events.find(e => e.type === 'info' && e.data.type === 'adaptive_end');
  const tier = trace.tierUsage ?? computeTierUsage(trace.spans);

  const decisions: EscalationDecision[] = [];
  const steps: TrajectoryStep[] = [];
  for (const e of events) {
    if (e.type !== 'escalation_decision') continue;
    const d = e.data as Record<string, unknown>;
    const decision = {
      step: Number(d.step),
      action: d.action as EscalationDecision['action'],
      score: Number(d.score),
      reason: String(d.reason ?? ''),
      confidence: (d.confidence ?? {}) as EscalationDecision['confidence'],
      tier: (d.tier as ModelTier) ?? ModelTier.SLM,
      estimatedCostUsd: d.estimatedCostUsd as number | undefined,
      consultId: d.consultId as string | undefined,
      timestamp: e.wallClock,
    };
    decisions.push(decision);
    steps.push({
      step: decision.step,
      description: String(d.description ?? describeDecision(decision)),
      toolName: d.toolName as string | undefined,
      tier: decision.tier,
      success: d.success !== false,
      verified: d.verified as boolean | undefined,
      action: decision.action,
      confidence: decision.score,
      reason: decision.reason,
      consultId: decision.consultId,
    });
  }

  const consults: TrajectoryConsult[] = events
    .filter(e => e.type === 'consultation')
    .map(e => ({
      consultId: String(e.data.consultId),
      step: Number(e.data.step ?? 0),
      model: String(e.data.model ?? ''),
      tokens: Number(e.data.tokens ?? 0),
      costUsd: Number(e.data.costUsd ?? 0),
      question: String(e.data.question ?? ''),
    }));

  const handoffs = events.filter(e => e.type === 'handoff');
  const status = String(end?.data.status ?? 'unknown');

  return {
    taskId: trace.taskId,
    mode: (start.data.mode as ExecutionMode) ?? 'adaptive',
    success: status === 'completed',
    status,
    costUsd: round(trace.budget.used?.costUsd ?? 0, 6),
    estimatedLlmOnlyCostUsd: estimateLlmOnly(tier, end?.data.llmPricePerToken as number | undefined),
    latencyMs: Math.round(trace.totalDurationMs ?? 0),
    slmTokens: tier.slmTokens,
    midTokens: tier.midTokens,
    llmTokens: tier.llmTokens,
    consultations: consults.length,
    handoffs: handoffs.length,
    handoffAtStep: handoffs.length > 0 ? Number(handoffs[0].data.step) : undefined,
    toolCalls: trace.budget.used?.toolCallsUsed ?? 0,
    trajectoryLength: decisions.length,
    verifierKinds: [...new Set(events.filter(e => e.type === 'step_verified').map(e => String(e.data.kind)).filter(k => k && k !== 'none'))],
    steps,
    consults,
    decisions,
  };
}

/** ASCII trajectory tree, for the CLI and for the README. */
export function renderTrajectory(report: TrajectoryReport): string {
  const lines: string[] = [];
  lines.push(`Task ${report.taskId}  mode=${report.mode}  status=${report.status}`);
  lines.push(`${(report.steps[0]?.tier ?? ModelTier.SLM).toUpperCase()} start`);
  lines.push('│');
  const consultsByStep = new Map(report.consults.map(c => [c.step, c]));
  report.steps.forEach((s, i) => {
    const last = i === report.steps.length - 1;
    const branch = last && report.status !== 'completed' ? '└─' : '├─';
    const label = `${s.step + 1} ${s.description}${s.toolName ? ` (${s.toolName})` : ''}`;
    const flag = !s.success ? ' FAILED' : s.verified === false ? ' verify=fail' : s.verified === true ? ' verify=pass' : '';
    lines.push(`${branch} ${pad(label, 40)} ${pad(s.action.toUpperCase(), 9)} conf ${s.confidence.toFixed(2)}${flag}`);
    if (s.action === 'consult') {
      const c = consultsByStep.get(s.step);
      lines.push(`│     → CONSULT ${c ? `${c.model}  ${c.tokens.toLocaleString()} tok  $${c.costUsd.toFixed(4)}` : ''}`);
      if (c?.question) lines.push(`│       q: ${truncate(c.question, 70)}`);
    } else if (s.action === 'handoff') {
      const next = report.steps[i + 1];
      lines.push(`│     → HANDOFF to ${(next?.tier ?? ModelTier.LLM).toUpperCase()}  (${truncate(s.reason, 60)})`);
    } else if (s.action === 'abort') {
      lines.push(`│     → ABORT  (${truncate(s.reason, 60)})`);
    }
  });
  if (report.status === 'completed') lines.push('└─ Complete');
  lines.push('');
  lines.push(`SLM tokens:          ${report.slmTokens.toLocaleString()}`);
  if (report.midTokens) lines.push(`MID tokens:          ${report.midTokens.toLocaleString()}`);
  lines.push(`LLM tokens:          ${report.llmTokens.toLocaleString()}`);
  lines.push(`Total cost:          $${report.costUsd.toFixed(4)}`);
  if (report.estimatedLlmOnlyCostUsd !== undefined) {
    lines.push(`Estimated LLM-only:  $${report.estimatedLlmOnlyCostUsd.toFixed(4)}`);
  }
  lines.push(`Consultations: ${report.consultations}  Handoffs: ${report.handoffs}  Tool calls: ${report.toolCalls}  Steps: ${report.trajectoryLength}`);
  if (report.verifierKinds.length > 0) lines.push(`Verifiers: ${report.verifierKinds.join(', ')}`);
  return lines.join('\n');
}

function estimateLlmOnly(
  tier: { slmTokens: number; midTokens?: number; llmTokens: number; llmCostUsd: number },
  fallbackPricePerToken?: number,
): number | undefined {
  const perToken = tier.llmTokens > 0 ? tier.llmCostUsd / tier.llmTokens : fallbackPricePerToken;
  if (perToken === undefined || !Number.isFinite(perToken)) return undefined;
  return round(tier.llmCostUsd + (tier.slmTokens + (tier.midTokens ?? 0)) * perToken, 6);
}

function describeDecision(d: EscalationDecision): string {
  return d.action === 'consult' ? 'consult' : d.action === 'handoff' ? 'handoff' : d.action === 'abort' ? 'abort' : 'agent turn';
}

function collectEvents(spans: TraceSpan[]): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const s of spans) {
    out.push(...s.events);
    out.push(...collectEvents(s.children));
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + '…' : s + ' '.repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
