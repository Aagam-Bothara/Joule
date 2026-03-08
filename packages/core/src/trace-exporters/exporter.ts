/**
 * TraceExporter — pluggable interface for exporting execution traces
 * to external observability backends (Langfuse, OTLP, etc.).
 */

import type { ExecutionTrace } from '@joule/shared';

export interface TraceExporter {
  /** Human-readable name for logging */
  readonly name: string;

  /** Export a completed trace. Should not throw — failures are logged and ignored. */
  export(trace: ExecutionTrace): Promise<void>;

  /** Graceful shutdown — flush any pending exports. */
  shutdown(): Promise<void>;
}
