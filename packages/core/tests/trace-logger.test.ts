import { describe, it, expect } from 'vitest';
import { TraceLogger } from '../src/trace-logger.js';

describe('TraceLogger', () => {
  it('creates and retrieves a trace', () => {
    const logger = new TraceLogger();
    const budget = {
      maxTokens: 1000,
      maxLatencyMs: 5000,
      maxToolCalls: 3,
      maxEscalations: 0,
      costCeilingUsd: 0.01,
    };
    const budgetUsage = {
      tokensUsed: 100,
      tokensRemaining: 900,
      toolCallsUsed: 1,
      toolCallsRemaining: 2,
      escalationsUsed: 0,
      escalationsRemaining: 0,
      costUsd: 0,
      costRemaining: 0.01,
      elapsedMs: 100,
      latencyRemaining: 4900,
    };

    logger.createTrace('trace_1', 'task_1', budget);
    const trace = logger.getTrace('trace_1', budgetUsage);

    expect(trace.traceId).toBe('trace_1');
    expect(trace.taskId).toBe('task_1');
    expect(trace.budget.allocated).toEqual(budget);
    expect(trace.budget.used).toEqual(budgetUsage);
  });

  it('records spans and events', () => {
    const logger = new TraceLogger();
    logger.createTrace('trace_2', 'task_2', {
      maxTokens: 1000,
      maxLatencyMs: 5000,
      maxToolCalls: 3,
      maxEscalations: 0,
      costCeilingUsd: 0.01,
    });

    const spanId = logger.startSpan('trace_2', 'test-span');
    logger.logEvent('trace_2', 'info', { message: 'hello' });
    logger.endSpan('trace_2', spanId);

    const trace = logger.getTrace('trace_2', {
      tokensUsed: 0, tokensRemaining: 1000,
      toolCallsUsed: 0, toolCallsRemaining: 3,
      escalationsUsed: 0, escalationsRemaining: 0,
      costUsd: 0, costRemaining: 0.01,
      elapsedMs: 0, latencyRemaining: 5000,
    });

    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0].name).toBe('test-span');
    expect(trace.spans[0].events).toHaveLength(1);
    expect(trace.spans[0].events[0].type).toBe('info');
  });

  it('tracks whether trace exists', () => {
    const logger = new TraceLogger();
    expect(logger.hasTrace('nonexistent')).toBe(false);
    logger.createTrace('trace_3', 'task_3', {
      maxTokens: 1000,
      maxLatencyMs: 5000,
      maxToolCalls: 3,
      maxEscalations: 0,
      costCeilingUsd: 0.01,
    });
    expect(logger.hasTrace('trace_3')).toBe(true);
  });
});
