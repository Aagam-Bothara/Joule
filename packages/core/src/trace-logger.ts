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

export class TraceLogger {
  private traces = new Map<string, TraceState>();

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
    return {
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
