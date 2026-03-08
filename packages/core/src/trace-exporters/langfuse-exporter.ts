/**
 * LangfuseExporter — exports Joule traces to Langfuse for LLM observability.
 *
 * Maps Joule's ExecutionTrace to Langfuse's trace/span/generation model:
 *   - ExecutionTrace → Langfuse Trace
 *   - TraceSpan → Langfuse Span
 *   - model_call events → Langfuse Generation (with token/cost tracking)
 */

import type { ExecutionTrace, TraceSpan } from '@joule/shared';
import type { TraceExporter } from './exporter.js';

export interface LangfuseExporterConfig {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
}

export class LangfuseExporter implements TraceExporter {
  readonly name = 'langfuse';
  private config: LangfuseExporterConfig;
  private langfuse: LangfuseClient | null = null;

  constructor(config: LangfuseExporterConfig) {
    this.config = config;
  }

  private async getClient(): Promise<LangfuseClient> {
    if (this.langfuse) return this.langfuse;

    try {
      // Dynamic import — langfuse is an optional dependency
      // @ts-expect-error langfuse may not be installed
      const mod = await import('langfuse');
      const Langfuse = mod.Langfuse ?? mod.default?.Langfuse ?? mod.default;
      const client: LangfuseClient = new Langfuse({
        publicKey: this.config.publicKey,
        secretKey: this.config.secretKey,
        baseUrl: this.config.baseUrl ?? 'https://cloud.langfuse.com',
      });
      this.langfuse = client;
      return client;
    } catch {
      throw new Error('langfuse package not installed. Run: npm install langfuse');
    }
  }

  async export(trace: ExecutionTrace): Promise<void> {
    try {
      const client = await this.getClient();

      const lfTrace = client.trace({
        id: trace.traceId,
        name: `joule-task-${trace.taskId}`,
        metadata: {
          taskId: trace.taskId,
          totalDurationMs: trace.totalDurationMs,
          budgetAllocated: trace.budget.allocated,
          budgetUsed: trace.budget.used,
        },
      });

      // Export each span recursively
      for (const span of trace.spans) {
        this.exportSpan(lfTrace, span);
      }

      // Flush to ensure data is sent
      await client.flushAsync?.();
    } catch {
      // Export is best-effort — silently fail
    }
  }

  private exportSpan(parent: LangfuseTraceOrSpan, span: TraceSpan): void {
    const lfSpan = parent.span({
      name: span.name,
      startTime: new Date(span.startTime),
      endTime: span.endTime ? new Date(span.endTime) : undefined,
    });

    for (const event of span.events) {
      if (event.type === 'model_call') {
        // Model calls become Langfuse Generations
        lfSpan.generation({
          name: String(event.data.model ?? 'unknown'),
          model: String(event.data.model ?? 'unknown'),
          modelParameters: {
            provider: String(event.data.provider ?? ''),
            tier: String(event.data.tier ?? ''),
          },
          usage: {
            promptTokens: Number(event.data.promptTokens ?? 0),
            completionTokens: Number(event.data.completionTokens ?? 0),
            totalTokens: Number(event.data.totalTokens ?? 0),
          },
          metadata: {
            costUsd: event.data.costUsd,
            latencyMs: event.data.latencyMs,
            confidence: event.data.confidence,
            finishReason: event.data.finishReason,
          },
        });
      } else if (event.type === 'tool_call') {
        lfSpan.event({
          name: `tool:${event.data.toolName}`,
          metadata: {
            input: event.data.input,
            success: event.data.success,
            durationMs: event.data.durationMs,
            error: event.data.error,
          },
        });
      }
    }

    // Recurse into children
    for (const child of span.children) {
      this.exportSpan(lfSpan, child);
    }
  }

  async shutdown(): Promise<void> {
    if (this.langfuse) {
      try {
        await this.langfuse.flushAsync?.();
        await this.langfuse.shutdownAsync?.();
      } catch {
        // Best-effort shutdown
      }
      this.langfuse = null;
    }
  }
}

// Minimal type declarations for Langfuse SDK (avoid requiring @types)
interface LangfuseClient {
  trace(params: Record<string, unknown>): LangfuseTraceOrSpan;
  flushAsync?(): Promise<void>;
  shutdownAsync?(): Promise<void>;
}

interface LangfuseTraceOrSpan {
  span(params: Record<string, unknown>): LangfuseTraceOrSpan;
  generation(params: Record<string, unknown>): void;
  event(params: Record<string, unknown>): void;
}
