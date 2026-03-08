import { useState, useEffect } from 'react';
import { fetchTaskTrace } from '../api/client.ts';

interface TraceSpan {
  id: string;
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  events: TraceEvent[];
  children: TraceSpan[];
}

interface TraceEvent {
  id: string;
  traceId: string;
  parentSpanId?: string;
  type: string;
  timestamp: number;
  wallClock?: string;
  data: Record<string, unknown>;
}

export interface ExecutionTrace {
  traceId: string;
  taskId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  budget: {
    allocated: Record<string, unknown>;
    used: Record<string, unknown>;
  };
  spans: TraceSpan[];
}

export type { TraceSpan, TraceEvent };

export function useTrace(taskId: string | null) {
  const [trace, setTrace] = useState<ExecutionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setTrace(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchTaskTrace(taskId)
      .then((data) => {
        if (!cancelled) {
          setTrace(data as ExecutionTrace);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [taskId]);

  return { trace, loading, error };
}
