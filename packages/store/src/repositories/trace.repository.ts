import type Database from 'better-sqlite3';

export interface TraceData {
  traceId: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  budgetAllocated?: unknown;
  budgetUsed?: unknown;
  spans: SpanData[];
}

export interface SpanData {
  id: string;
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  parentSpanId?: string;
  events: EventData[];
  children: SpanData[];
}

export interface EventData {
  id: string;
  traceId: string;
  spanId?: string;
  type: string;
  timestamp: number;
  wallClock: string;
  duration?: number;
  data?: unknown;
}

export class TraceRepository {
  private insertTraceStmt: Database.Statement;
  private insertSpanStmt: Database.Statement;
  private insertEventStmt: Database.Statement;
  private getTraceStmt: Database.Statement;
  private getSpansStmt: Database.Statement;
  private getEventsStmt: Database.Statement;
  private getByTaskStmt: Database.Statement;
  private deleteStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertTraceStmt = db.prepare(`
      INSERT OR REPLACE INTO traces (trace_id, task_id, started_at, completed_at, duration_ms, budget_allocated, budget_used)
      VALUES (@trace_id, @task_id, @started_at, @completed_at, @duration_ms, @budget_allocated, @budget_used)
    `);
    this.insertSpanStmt = db.prepare(`
      INSERT OR REPLACE INTO trace_spans (id, trace_id, parent_span_id, name, start_time, end_time)
      VALUES (@id, @trace_id, @parent_span_id, @name, @start_time, @end_time)
    `);
    this.insertEventStmt = db.prepare(`
      INSERT OR REPLACE INTO trace_events (id, trace_id, span_id, type, timestamp, wall_clock, duration, data)
      VALUES (@id, @trace_id, @span_id, @type, @timestamp, @wall_clock, @duration, @data)
    `);
    this.getTraceStmt = db.prepare('SELECT * FROM traces WHERE trace_id = ?');
    this.getSpansStmt = db.prepare('SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY start_time ASC');
    this.getEventsStmt = db.prepare('SELECT * FROM trace_events WHERE trace_id = ? ORDER BY timestamp ASC');
    this.getByTaskStmt = db.prepare('SELECT * FROM traces WHERE task_id = ?');
    this.deleteStmt = db.prepare('DELETE FROM traces WHERE trace_id = ?');
  }

  /** Save a complete trace with all spans and events in a single transaction. */
  save(trace: TraceData): void {
    const saveTx = this.db.transaction(() => {
      this.insertTraceStmt.run({
        trace_id: trace.traceId,
        task_id: trace.taskId,
        started_at: trace.startedAt,
        completed_at: trace.completedAt ?? null,
        duration_ms: trace.durationMs ?? null,
        budget_allocated: trace.budgetAllocated ? JSON.stringify(trace.budgetAllocated) : null,
        budget_used: trace.budgetUsed ? JSON.stringify(trace.budgetUsed) : null,
      });

      // Flatten span tree and insert all spans + events
      const flatSpans = this.flattenSpans(trace.spans);
      for (const span of flatSpans) {
        this.insertSpanStmt.run({
          id: span.id,
          trace_id: trace.traceId,
          parent_span_id: span.parentSpanId ?? null,
          name: span.name,
          start_time: span.startTime,
          end_time: span.endTime ?? null,
        });

        for (const event of span.events) {
          this.insertEventStmt.run({
            id: event.id,
            trace_id: trace.traceId,
            span_id: span.id,
            type: event.type,
            timestamp: event.timestamp,
            wall_clock: event.wallClock,
            duration: event.duration ?? null,
            data: event.data ? JSON.stringify(event.data) : null,
          });
        }
      }
    });
    saveTx();
  }

  /** Load a complete trace, reconstructing the span tree from flat rows. */
  load(traceId: string): TraceData | null {
    const row = this.getTraceStmt.get(traceId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const spanRows = this.getSpansStmt.all(traceId) as Array<Record<string, unknown>>;
    const eventRows = this.getEventsStmt.all(traceId) as Array<Record<string, unknown>>;

    // Group events by span_id
    const eventsBySpan = new Map<string, EventData[]>();
    for (const e of eventRows) {
      const spanId = e.span_id as string | null;
      const key = spanId ?? '__root__';
      if (!eventsBySpan.has(key)) eventsBySpan.set(key, []);
      eventsBySpan.get(key)!.push({
        id: e.id as string,
        traceId: e.trace_id as string,
        spanId: spanId ?? undefined,
        type: e.type as string,
        timestamp: e.timestamp as number,
        wallClock: e.wall_clock as string,
        duration: e.duration as number | undefined,
        data: e.data ? JSON.parse(e.data as string) : undefined,
      });
    }

    // Build span map
    const spanMap = new Map<string, SpanData>();
    for (const s of spanRows) {
      spanMap.set(s.id as string, {
        id: s.id as string,
        traceId: s.trace_id as string,
        name: s.name as string,
        startTime: s.start_time as number,
        endTime: s.end_time as number | undefined,
        parentSpanId: s.parent_span_id as string | undefined,
        events: eventsBySpan.get(s.id as string) ?? [],
        children: [],
      });
    }

    // Wire up parent-child
    const rootSpans: SpanData[] = [];
    for (const span of spanMap.values()) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        spanMap.get(span.parentSpanId)!.children.push(span);
      } else {
        rootSpans.push(span);
      }
    }

    return {
      traceId: row.trace_id as string,
      taskId: row.task_id as string,
      startedAt: row.started_at as string,
      completedAt: row.completed_at as string | undefined,
      durationMs: row.duration_ms as number | undefined,
      budgetAllocated: row.budget_allocated ? JSON.parse(row.budget_allocated as string) : undefined,
      budgetUsed: row.budget_used ? JSON.parse(row.budget_used as string) : undefined,
      spans: rootSpans,
    };
  }

  getByTaskId(taskId: string): TraceData | null {
    const row = this.getByTaskStmt.get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.load(row.trace_id as string);
  }

  list(options?: { limit?: number; offset?: number }): Array<{
    traceId: string;
    taskId: string;
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
  }> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const rows = this.db
      .prepare('SELECT trace_id, task_id, started_at, completed_at, duration_ms FROM traces ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      traceId: r.trace_id as string,
      taskId: r.task_id as string,
      startedAt: r.started_at as string,
      completedAt: r.completed_at as string | undefined,
      durationMs: r.duration_ms as number | undefined,
    }));
  }

  delete(traceId: string): boolean {
    const result = this.deleteStmt.run(traceId);
    return result.changes > 0;
  }

  /** Flatten a nested span tree into a flat array, preserving parentSpanId. */
  private flattenSpans(spans: SpanData[], parentId?: string): Array<SpanData & { parentSpanId?: string }> {
    const result: Array<SpanData & { parentSpanId?: string }> = [];
    for (const span of spans) {
      result.push({ ...span, parentSpanId: parentId });
      if (span.children.length > 0) {
        result.push(...this.flattenSpans(span.children, span.id));
      }
    }
    return result;
  }
}
