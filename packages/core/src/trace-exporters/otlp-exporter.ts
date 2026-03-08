/**
 * OtlpExporter — exports Joule traces to any OpenTelemetry-compatible backend
 * via the OTLP HTTP/JSON protocol.
 *
 * Converts ExecutionTrace → OTLP ResourceSpans and POSTs to the configured endpoint.
 */

import type { ExecutionTrace, TraceSpan, TraceEvent } from '@joule/shared';
import type { TraceExporter } from './exporter.js';

export interface OtlpExporterConfig {
  /** OTLP endpoint (e.g., 'http://localhost:4318/v1/traces') */
  endpoint: string;
  /** Optional headers for authentication */
  headers?: Record<string, string>;
}

export class OtlpExporter implements TraceExporter {
  readonly name = 'otlp';
  private config: OtlpExporterConfig;

  constructor(config: OtlpExporterConfig) {
    this.config = config;
  }

  async export(trace: ExecutionTrace): Promise<void> {
    const payload = this.toOtlpPayload(trace);

    try {
      const res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        // Log but don't throw — export is best-effort
        console.warn(`[otlp-exporter] Export failed: ${res.status} ${res.statusText}`);
      }
    } catch {
      // Network errors are silently ignored
    }
  }

  async shutdown(): Promise<void> {
    // No resources to clean up for HTTP exporter
  }

  private toOtlpPayload(trace: ExecutionTrace) {
    const spans = this.flattenSpans(trace.spans, trace.traceId);

    return {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'joule' } },
            { key: 'service.version', value: { stringValue: '0.1.0' } },
            { key: 'joule.task.id', value: { stringValue: trace.taskId } },
          ],
        },
        scopeSpans: [{
          scope: { name: 'joule-tracer', version: '0.1.0' },
          spans,
        }],
      }],
    };
  }

  private flattenSpans(
    spans: TraceSpan[],
    traceId: string,
    parentSpanId?: string,
  ): OtlpSpan[] {
    const result: OtlpSpan[] = [];

    for (const span of spans) {
      const startTimeUnixNano = String(Math.floor(span.startTime * 1_000_000));
      const endTimeUnixNano = span.endTime
        ? String(Math.floor(span.endTime * 1_000_000))
        : startTimeUnixNano;

      const otlpSpan: OtlpSpan = {
        traceId: this.toHex(traceId),
        spanId: this.toHex(span.id),
        parentSpanId: parentSpanId ? this.toHex(parentSpanId) : undefined,
        name: span.name,
        kind: 1, // SPAN_KIND_INTERNAL
        startTimeUnixNano,
        endTimeUnixNano,
        attributes: this.spanAttributes(span),
        events: span.events.map(e => this.toOtlpEvent(e)),
        status: { code: 1 }, // STATUS_CODE_OK
      };

      result.push(otlpSpan);

      // Recurse into children
      result.push(...this.flattenSpans(span.children, traceId, span.id));
    }

    return result;
  }

  private spanAttributes(span: TraceSpan): OtlpAttribute[] {
    const attrs: OtlpAttribute[] = [
      { key: 'span.name', value: { stringValue: span.name } },
      { key: 'span.event_count', value: { intValue: String(span.events.length) } },
    ];

    // Add aggregated model call info
    const modelCalls = span.events.filter(e => e.type === 'model_call');
    if (modelCalls.length > 0) {
      const totalTokens = modelCalls.reduce((sum, e) => sum + Number(e.data.totalTokens ?? 0), 0);
      const totalCost = modelCalls.reduce((sum, e) => sum + Number(e.data.costUsd ?? 0), 0);
      attrs.push({ key: 'llm.token_count', value: { intValue: String(totalTokens) } });
      attrs.push({ key: 'llm.cost_usd', value: { doubleValue: totalCost } });
    }

    return attrs;
  }

  private toOtlpEvent(event: TraceEvent) {
    return {
      name: event.type,
      timeUnixNano: String(Math.floor(event.timestamp * 1_000_000)),
      attributes: Object.entries(event.data).map(([key, value]) => ({
        key,
        value: typeof value === 'number'
          ? { doubleValue: value }
          : { stringValue: String(value ?? '') },
      })),
    };
  }

  /** Convert a string ID to a hex representation (OTLP requires hex trace/span IDs) */
  private toHex(id: string): string {
    // Strip non-hex chars, pad to 32 chars for trace IDs, 16 for span IDs
    const hex = Buffer.from(id).toString('hex');
    return hex.slice(0, 32).padStart(16, '0');
  }
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  events: unknown[];
  status: { code: number };
}

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}
