/**
 * MetricsCollector for Joule.
 *
 * Provides counters, gauges, and histograms with Prometheus-compatible
 * text export and OpenTelemetry-compatible trace span conversion.
 */

import type { TraceSpan } from '@joule/shared';

export interface MetricLabels {
  [key: string]: string;
}

interface HistogramStats {
  count: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Create a composite key from metric name + labels for deduplication. */
function labelKey(name: string, labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `${name}{${sorted.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

export class MetricsCollector {
  private static instance: MetricsCollector | undefined;

  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  static setInstance(collector: MetricsCollector): void {
    MetricsCollector.instance = collector;
  }

  static reset(): void {
    MetricsCollector.instance = undefined;
  }

  // ── Counters ────────────────────────────────────────────────

  incrementCounter(name: string, value = 1, labels?: MetricLabels): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  getCounter(name: string, labels?: MetricLabels): number {
    return this.counters.get(labelKey(name, labels)) ?? 0;
  }

  // ── Gauges ──────────────────────────────────────────────────

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    this.gauges.set(labelKey(name, labels), value);
  }

  getGauge(name: string, labels?: MetricLabels): number {
    return this.gauges.get(labelKey(name, labels)) ?? 0;
  }

  // ── Histograms ──────────────────────────────────────────────

  recordHistogram(name: string, value: number, labels?: MetricLabels): void {
    const key = labelKey(name, labels);
    const existing = this.histograms.get(key);
    if (existing) {
      existing.push(value);
    } else {
      this.histograms.set(key, [value]);
    }
  }

  getHistogramStats(name: string, labels?: MetricLabels): HistogramStats {
    const key = labelKey(name, labels);
    const values = this.histograms.get(key) ?? [];

    if (values.length === 0) {
      return { count: 0, sum: 0, avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);

    return {
      count: sorted.length,
      sum,
      avg: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    };
  }

  // ── Prometheus Export ───────────────────────────────────────

  toPrometheusText(): string {
    const lines: string[] = [];

    // Counters
    for (const [key, value] of this.counters) {
      lines.push(`# TYPE ${extractName(key)} counter`);
      lines.push(`${key} ${value}`);
    }

    // Gauges
    for (const [key, value] of this.gauges) {
      lines.push(`# TYPE ${extractName(key)} gauge`);
      lines.push(`${key} ${value}`);
    }

    // Histograms — emit summary-style metrics
    for (const [key, values] of this.histograms) {
      const name = extractName(key);
      const stats = this.getHistogramStats(name);
      lines.push(`# TYPE ${name} summary`);
      lines.push(`${name}_count ${stats.count}`);
      lines.push(`${name}_sum ${stats.sum}`);
      lines.push(`${name}{quantile="0.5"} ${stats.p50}`);
      lines.push(`${name}{quantile="0.95"} ${stats.p95}`);
      lines.push(`${name}{quantile="0.99"} ${stats.p99}`);
    }

    return lines.join('\n') + '\n';
  }

  // ── OpenTelemetry Span Conversion ──────────────────────────

  /**
   * Convert a Joule TraceSpan to an OTLP-compatible JSON span.
   * This produces a simplified OTLP format suitable for JSON export.
   */
  static traceSpanToOTLP(span: TraceSpan): Record<string, unknown> {
    return {
      traceId: span.traceId,
      spanId: span.id,
      name: span.name,
      kind: 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: span.startTime * 1_000_000, // ms → ns
      endTimeUnixNano: (span.endTime ?? span.startTime) * 1_000_000,
      attributes: span.events
        .filter(e => e.data)
        .flatMap(e =>
          Object.entries(e.data).map(([k, v]) => ({
            key: k,
            value: { stringValue: String(v) },
          })),
        ),
      events: span.events.map(e => ({
        name: e.type,
        timeUnixNano: e.timestamp * 1_000_000,
        attributes: Object.entries(e.data).map(([k, v]) => ({
          key: k,
          value: { stringValue: String(v) },
        })),
      })),
      status: { code: 'STATUS_CODE_OK' },
    };
  }

  // ── Utility ─────────────────────────────────────────────────

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  /** Return a snapshot of all metrics as JSON. */
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of this.counters) {
      result[`counter:${key}`] = value;
    }
    for (const [key, value] of this.gauges) {
      result[`gauge:${key}`] = value;
    }
    for (const [key] of this.histograms) {
      const name = extractName(key);
      result[`histogram:${key}`] = this.getHistogramStats(name);
    }

    return result;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Extract the plain metric name from a labeled key like `name{label="val"}`. */
function extractName(key: string): string {
  const braceIdx = key.indexOf('{');
  return braceIdx > 0 ? key.slice(0, braceIdx) : key;
}
