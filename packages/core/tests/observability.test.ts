import { describe, it, expect, beforeEach } from 'vitest';
import { Logger } from '../src/logger.js';
import { MetricsCollector } from '../src/metrics-collector.js';

// ---------------------------------------------------------------------------
// Logger Tests
// ---------------------------------------------------------------------------

describe('Logger', () => {
  beforeEach(() => {
    Logger.reset();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = Logger.getInstance();
      const b = Logger.getInstance();
      expect(a).toBe(b);
    });

    it('should allow replacing the instance', () => {
      const original = Logger.getInstance();
      const custom = new Logger({ level: 'error' });
      Logger.setInstance(custom);
      expect(Logger.getInstance()).toBe(custom);
      expect(Logger.getInstance()).not.toBe(original);
    });
  });

  describe('level filtering', () => {
    it('should filter messages below the configured level', () => {
      const entries: any[] = [];
      const logger = new Logger({ level: 'warn', structured: false });
      logger.addHandler((entry) => entries.push(entry));

      logger.debug('should be filtered');
      logger.info('should be filtered');
      logger.warn('should pass');
      logger.error('should pass');

      expect(entries.length).toBe(2);
      expect(entries[0].level).toBe('warn');
      expect(entries[1].level).toBe('error');
    });

    it('should pass all messages at debug level', () => {
      const entries: any[] = [];
      const logger = new Logger({ level: 'debug', structured: false });
      logger.addHandler((entry) => entries.push(entry));

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(entries.length).toBe(4);
    });
  });

  describe('child loggers', () => {
    it('should inherit parent context and merge child context', () => {
      const entries: any[] = [];
      const parent = new Logger({ level: 'debug', structured: false });
      parent.addHandler((entry) => entries.push(entry));

      const child = parent.child({ component: 'executor', taskId: 'task_1' });
      child.info('test message', { agentId: 'agent_1' });

      expect(entries.length).toBe(1);
      expect(entries[0].context.component).toBe('executor');
      expect(entries[0].context.taskId).toBe('task_1');
      expect(entries[0].context.agentId).toBe('agent_1');
    });

    it('child context should override parent context', () => {
      const entries: any[] = [];
      const parent = new Logger({ level: 'debug', structured: false });
      parent.addHandler((entry) => entries.push(entry));

      const child = parent.child({ component: 'parent-component' });
      child.info('msg', { component: 'child-component' });

      expect(entries[0].context.component).toBe('child-component');
    });
  });

  describe('log entries', () => {
    it('should include timestamp in ISO format', () => {
      const entries: any[] = [];
      const logger = new Logger({ level: 'info', structured: false });
      logger.addHandler((entry) => entries.push(entry));

      logger.info('test');

      expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should not include context when none provided', () => {
      const entries: any[] = [];
      const logger = new Logger({ level: 'info', structured: false });
      logger.addHandler((entry) => entries.push(entry));

      logger.info('test');

      expect(entries[0].context).toBeUndefined();
    });
  });

  describe('handler errors', () => {
    it('should not crash when a handler throws', () => {
      const logger = new Logger({ level: 'info', structured: false });
      logger.addHandler(() => { throw new Error('handler crash'); });

      // Should not throw
      expect(() => logger.info('test')).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// MetricsCollector Tests
// ---------------------------------------------------------------------------

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    MetricsCollector.reset();
    metrics = new MetricsCollector();
  });

  describe('counters', () => {
    it('should increment counters', () => {
      metrics.incrementCounter('joule_tasks_total');
      metrics.incrementCounter('joule_tasks_total');
      metrics.incrementCounter('joule_tasks_total', 3);

      expect(metrics.getCounter('joule_tasks_total')).toBe(5);
    });

    it('should support labeled counters', () => {
      metrics.incrementCounter('joule_tasks_total', 1, { status: 'completed' });
      metrics.incrementCounter('joule_tasks_total', 1, { status: 'failed' });
      metrics.incrementCounter('joule_tasks_total', 2, { status: 'completed' });

      expect(metrics.getCounter('joule_tasks_total', { status: 'completed' })).toBe(3);
      expect(metrics.getCounter('joule_tasks_total', { status: 'failed' })).toBe(1);
    });

    it('should return 0 for unknown counters', () => {
      expect(metrics.getCounter('nonexistent')).toBe(0);
    });
  });

  describe('gauges', () => {
    it('should set and get gauge values', () => {
      metrics.setGauge('joule_active_tasks', 5);
      expect(metrics.getGauge('joule_active_tasks')).toBe(5);

      metrics.setGauge('joule_active_tasks', 3);
      expect(metrics.getGauge('joule_active_tasks')).toBe(3);
    });

    it('should return 0 for unknown gauges', () => {
      expect(metrics.getGauge('nonexistent')).toBe(0);
    });
  });

  describe('histograms', () => {
    it('should compute percentiles correctly', () => {
      // Add 100 values: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        metrics.recordHistogram('joule_latency_ms', i);
      }

      const stats = metrics.getHistogramStats('joule_latency_ms');
      expect(stats.count).toBe(100);
      expect(stats.sum).toBe(5050);
      expect(stats.avg).toBe(50.5);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(100);
      expect(stats.p50).toBe(50);
      expect(stats.p95).toBe(95);
      expect(stats.p99).toBe(99);
    });

    it('should handle single value', () => {
      metrics.recordHistogram('single', 42);

      const stats = metrics.getHistogramStats('single');
      expect(stats.count).toBe(1);
      expect(stats.sum).toBe(42);
      expect(stats.avg).toBe(42);
      expect(stats.p50).toBe(42);
      expect(stats.p99).toBe(42);
    });

    it('should return zeros for empty histogram', () => {
      const stats = metrics.getHistogramStats('nonexistent');
      expect(stats.count).toBe(0);
      expect(stats.sum).toBe(0);
    });
  });

  describe('Prometheus export', () => {
    it('should produce valid Prometheus text format', () => {
      metrics.incrementCounter('joule_tasks_total', 42);
      metrics.setGauge('joule_active_tasks', 3);
      metrics.recordHistogram('joule_latency_ms', 100);
      metrics.recordHistogram('joule_latency_ms', 200);

      const text = metrics.toPrometheusText();

      expect(text).toContain('# TYPE joule_tasks_total counter');
      expect(text).toContain('joule_tasks_total 42');
      expect(text).toContain('# TYPE joule_active_tasks gauge');
      expect(text).toContain('joule_active_tasks 3');
      expect(text).toContain('# TYPE joule_latency_ms summary');
      expect(text).toContain('joule_latency_ms_count 2');
      expect(text).toContain('joule_latency_ms_sum 300');
    });
  });

  describe('OTLP conversion', () => {
    it('should convert TraceSpan to OTLP format', () => {
      const span = {
        id: 'span_1',
        traceId: 'trace_1',
        name: 'test_span',
        startTime: 1000,
        endTime: 2000,
        events: [{
          id: 'evt_1',
          traceId: 'trace_1',
          type: 'info' as const,
          timestamp: 1500,
          wallClock: '2026-01-01T00:00:00Z',
          data: { key: 'value' },
        }],
        children: [],
      };

      const otlp = MetricsCollector.traceSpanToOTLP(span);

      expect(otlp.traceId).toBe('trace_1');
      expect(otlp.spanId).toBe('span_1');
      expect(otlp.name).toBe('test_span');
      expect(otlp.startTimeUnixNano).toBe(1_000_000_000);
      expect(otlp.endTimeUnixNano).toBe(2_000_000_000);
      expect(otlp.kind).toBe('SPAN_KIND_INTERNAL');
      expect((otlp.events as any[]).length).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear all metrics', () => {
      metrics.incrementCounter('c1', 10);
      metrics.setGauge('g1', 5);
      metrics.recordHistogram('h1', 100);

      metrics.reset();

      expect(metrics.getCounter('c1')).toBe(0);
      expect(metrics.getGauge('g1')).toBe(0);
      expect(metrics.getHistogramStats('h1').count).toBe(0);
    });
  });
});
