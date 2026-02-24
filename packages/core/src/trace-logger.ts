import {
  generateId,
  monotonicNow,
  isoNow,
  type TraceEvent,
  type TraceSpan,
  type ExecutionTrace,
  type TraceEventType,
  type BudgetEnvelope,
  type BudgetUsage,
  type ModelRequest,
  type ModelResponse,
  type ToolInvocation,
  type ToolResult,
} from '@joule/shared';
import type { TraceRepository, TraceData, SpanData, EventData } from '@joule/store';

export class TraceLogger {
  private traces = new Map<string, TraceState>();
  private repo?: TraceRepository;

  constructor(traceRepo?: TraceRepository) {
    this.repo = traceRepo;
  }

  createTrace(traceId: string, taskId: string, budget: BudgetEnvelope): void {
    this.traces.set(traceId, {
      traceId,
      taskId,
      startedAt: isoNow(),
      startTime: monotonicNow(),
      budget,
      spans: [],
      spanStack: [],
    });
  }

  startSpan(traceId: string, name: string, data?: Record<string, unknown>): string {
    const state = this.getState(traceId);
    const spanId = generateId('span');
    const parentSpanId = state.spanStack.length > 0
      ? state.spanStack[state.spanStack.length - 1]
      : undefined;

    const span: TraceSpan = {
      id: spanId,
      traceId,
      name,
      startTime: monotonicNow(),
      events: [],
      children: [],
    };

    if (data) {
      this.logEvent(traceId, 'info', data, spanId);
    }

    if (parentSpanId) {
      const parent = this.findSpan(state.spans, parentSpanId);
      parent?.children.push(span);
    } else {
      state.spans.push(span);
    }

    state.spanStack.push(spanId);
    return spanId;
  }

  endSpan(traceId: string, spanId: string): void {
    const state = this.getState(traceId);
    const span = this.findSpan(state.spans, spanId);
    if (span) {
      span.endTime = monotonicNow();
    }
    const idx = state.spanStack.indexOf(spanId);
    if (idx !== -1) {
      state.spanStack.splice(idx, 1);
    }
  }

  logEvent(
    traceId: string,
    type: TraceEventType,
    data: Record<string, unknown>,
    parentSpanId?: string,
  ): void {
    const state = this.getState(traceId);
    const event: TraceEvent = {
      id: generateId('evt'),
      traceId,
      parentSpanId: parentSpanId ?? state.spanStack[state.spanStack.length - 1],
      type,
      timestamp: monotonicNow(),
      wallClock: isoNow(),
      data,
    };

    const spanId = event.parentSpanId;
    if (spanId) {
      const span = this.findSpan(state.spans, spanId);
      span?.events.push(event);
    }
  }

  logModelCall(traceId: string, request: ModelRequest, response: ModelResponse): void {
    this.logEvent(traceId, 'model_call', {
      model: response.model,
      provider: response.provider,
      tier: response.tier,
      promptTokens: response.tokenUsage.promptTokens,
      completionTokens: response.tokenUsage.completionTokens,
      totalTokens: response.tokenUsage.totalTokens,
      latencyMs: response.latencyMs,
      costUsd: response.costUsd,
      confidence: response.confidence,
      finishReason: response.finishReason,
    });
  }

  logToolCall(traceId: string, invocation: ToolInvocation, result: ToolResult): void {
    this.logEvent(traceId, 'tool_call', {
      toolName: result.toolName,
      input: invocation.input,
      success: result.success,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  logRoutingDecision(traceId: string, decision: Record<string, unknown>): void {
    this.logEvent(traceId, 'routing_decision', decision);
  }

  logBudgetCheckpoint(traceId: string, label: string, usage: BudgetUsage): void {
    this.logEvent(traceId, 'budget_checkpoint', { label, ...usage });
  }

  logEnergyReport(traceId: string, report: Record<string, unknown>): void {
    this.logEvent(traceId, 'energy_report', report);
  }

  getTrace(traceId: string, budgetUsed: BudgetUsage): ExecutionTrace {
    const state = this.getState(traceId);
    const now = monotonicNow();
    const trace: ExecutionTrace = {
      traceId: state.traceId,
      taskId: state.taskId,
      startedAt: state.startedAt,
      completedAt: isoNow(),
      totalDurationMs: now - state.startTime,
      budget: {
        allocated: state.budget,
        used: budgetUsed,
      },
      spans: state.spans,
    };

    // Persist completed trace to SQLite if repository is available
    if (this.repo) {
      try {
        this.repo.save(this.toTraceData(trace));
      } catch {
        // Persistence is best-effort — don't fail the trace
      }
    }

    // Clean up in-memory state
    this.traces.delete(traceId);

    return trace;
  }

  /** Load a previously persisted trace from the database */
  loadTrace(traceId: string): ExecutionTrace | null {
    if (!this.repo) return null;
    const data = this.repo.load(traceId);
    if (!data) return null;
    return this.fromTraceData(data);
  }

  hasTrace(traceId: string): boolean {
    return this.traces.has(traceId);
  }

  private getState(traceId: string): TraceState {
    const state = this.traces.get(traceId);
    if (!state) throw new Error(`Trace not found: ${traceId}`);
    return state;
  }

  private findSpan(spans: TraceSpan[], id: string): TraceSpan | undefined {
    for (const span of spans) {
      if (span.id === id) return span;
      const found = this.findSpan(span.children, id);
      if (found) return found;
    }
    return undefined;
  }

  private toTraceData(trace: ExecutionTrace): TraceData {
    return {
      traceId: trace.traceId,
      taskId: trace.taskId,
      startedAt: trace.startedAt,
      completedAt: trace.completedAt,
      durationMs: trace.totalDurationMs,
      budgetAllocated: trace.budget.allocated,
      budgetUsed: trace.budget.used,
      spans: trace.spans.map(s => this.toSpanData(s)),
    };
  }

  private toSpanData(span: TraceSpan): SpanData {
    return {
      id: span.id,
      traceId: span.traceId,
      name: span.name,
      startTime: span.startTime,
      endTime: span.endTime,
      events: span.events.map(e => this.toEventData(e)),
      children: span.children.map(c => this.toSpanData(c)),
    };
  }

  private toEventData(event: TraceEvent): EventData {
    return {
      id: event.id,
      traceId: event.traceId,
      spanId: event.parentSpanId,
      type: event.type,
      timestamp: event.timestamp,
      wallClock: event.wallClock,
      duration: event.duration,
      data: event.data,
    };
  }

  private fromTraceData(data: TraceData): ExecutionTrace {
    return {
      traceId: data.traceId,
      taskId: data.taskId,
      startedAt: data.startedAt,
      completedAt: data.completedAt ?? '',
      totalDurationMs: data.durationMs ?? 0,
      budget: {
        allocated: (data.budgetAllocated ?? {}) as BudgetEnvelope,
        used: (data.budgetUsed ?? {}) as BudgetUsage,
      },
      spans: data.spans.map(s => this.fromSpanData(s)),
    };
  }

  private fromSpanData(data: SpanData): TraceSpan {
    return {
      id: data.id,
      traceId: data.traceId,
      name: data.name,
      startTime: data.startTime,
      endTime: data.endTime,
      events: data.events.map(e => ({
        id: e.id,
        traceId: e.traceId,
        parentSpanId: e.spanId,
        type: e.type as TraceEventType,
        timestamp: e.timestamp,
        wallClock: e.wallClock,
        duration: e.duration,
        data: e.data as Record<string, unknown>,
      })),
      children: data.children.map(c => this.fromSpanData(c)),
    };
  }
}

interface TraceState {
  traceId: string;
  taskId: string;
  startedAt: string;
  startTime: number;
  budget: BudgetEnvelope;
  spans: TraceSpan[];
  spanStack: string[];
}
