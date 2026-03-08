import React, { useState } from 'react';
import { useTrace } from '../hooks/useTrace.ts';
import { GanttChart } from '../components/GanttChart.tsx';
import { SpanDetail } from '../components/SpanDetail.tsx';
import type { TraceSpan } from '../hooks/useTrace.ts';

interface TraceTimelineProps {
  taskId: string | null;
  onBack: () => void;
}

const styles = {
  container: { padding: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginBottom: 24,
  },
  backBtn: {
    background: 'none',
    border: '1px solid #333',
    color: '#4ecdc4',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  title: { fontSize: 20, fontWeight: 700, color: '#fff' },
  subtitle: { color: '#999', fontSize: 13, marginTop: 4 },
  card: {
    background: '#111118',
    borderRadius: 8,
    border: '1px solid #222',
    padding: 20,
    marginBottom: 20,
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: 16,
    marginBottom: 24,
  },
  summaryItem: {
    background: '#1a1a2e',
    borderRadius: 6,
    padding: 14,
    textAlign: 'center' as const,
  },
  summaryLabel: { fontSize: 11, color: '#888', textTransform: 'uppercase' as const, marginBottom: 4 },
  summaryValue: { fontSize: 20, fontWeight: 700, color: '#4ecdc4', fontFamily: 'monospace' },
  legend: {
    display: 'flex',
    gap: 16,
    flexWrap: 'wrap' as const,
    marginBottom: 16,
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 12,
    color: '#999',
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 2,
    display: 'inline-block',
  },
  empty: {
    textAlign: 'center' as const,
    color: '#666',
    padding: 40,
    fontSize: 14,
  },
  loading: {
    textAlign: 'center' as const,
    color: '#4ecdc4',
    padding: 40,
    fontSize: 14,
  },
  error: {
    textAlign: 'center' as const,
    color: '#e74c3c',
    padding: 40,
    fontSize: 14,
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function countAllSpans(spans: TraceSpan[]): number {
  let count = spans.length;
  for (const span of spans) {
    count += countAllSpans(span.children);
  }
  return count;
}

function countEvents(spans: TraceSpan[]): { modelCalls: number; toolCalls: number; violations: number } {
  let modelCalls = 0;
  let toolCalls = 0;
  let violations = 0;

  function walk(spanList: TraceSpan[]) {
    for (const span of spanList) {
      for (const event of span.events) {
        if (event.type === 'model_call') modelCalls++;
        if (event.type === 'tool_call') toolCalls++;
        if (event.type.includes('violation')) violations++;
      }
      walk(span.children);
    }
  }

  walk(spans);
  return { modelCalls, toolCalls, violations };
}

function computeTotalCost(spans: TraceSpan[]): number {
  let cost = 0;
  function walk(spanList: TraceSpan[]) {
    for (const span of spanList) {
      for (const event of span.events) {
        if (event.type === 'model_call' && typeof event.data.costUsd === 'number') {
          cost += event.data.costUsd;
        }
      }
      walk(span.children);
    }
  }
  walk(spans);
  return cost;
}

function getTraceStartTime(spans: TraceSpan[]): number {
  let min = Infinity;
  function walk(list: TraceSpan[]) {
    for (const span of list) {
      if (span.startTime < min) min = span.startTime;
      walk(span.children);
    }
  }
  walk(spans);
  return min === Infinity ? 0 : min;
}

const LEGEND_ITEMS = [
  { label: 'Model Call', color: '#3498db' },
  { label: 'Tool Call', color: '#2ecc71' },
  { label: 'Planning', color: '#9b59b6' },
  { label: 'Execution', color: '#e67e22' },
  { label: 'Violation', color: '#e74c3c' },
  { label: 'Other', color: '#4ecdc4' },
];

export function TraceTimeline({ taskId, onBack }: TraceTimelineProps) {
  const { trace, loading, error } = useTrace(taskId);
  const [selectedSpan, setSelectedSpan] = useState<TraceSpan | null>(null);

  if (!taskId) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>Back</button>
          <div>
            <div style={styles.title}>Trace Timeline</div>
            <div style={styles.subtitle}>Select a task to view its execution timeline</div>
          </div>
        </div>
        <div style={styles.empty}>
          Navigate to Tasks and select a task to view its trace timeline.
        </div>
      </div>
    );
  }

  if (loading) {
    return <div style={styles.loading}>Loading trace data...</div>;
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>Back</button>
          <div style={styles.title}>Trace Timeline</div>
        </div>
        <div style={styles.error}>Failed to load trace: {error}</div>
      </div>
    );
  }

  if (!trace || trace.spans.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <button style={styles.backBtn} onClick={onBack}>Back</button>
          <div style={styles.title}>Trace Timeline</div>
        </div>
        <div style={styles.empty}>No trace data available for this task.</div>
      </div>
    );
  }

  const spanCount = countAllSpans(trace.spans);
  const { modelCalls, toolCalls, violations } = countEvents(trace.spans);
  const totalCost = computeTotalCost(trace.spans);
  const traceStartTime = getTraceStartTime(trace.spans);

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={onBack}>Back</button>
        <div>
          <div style={styles.title}>Trace Timeline</div>
          <div style={styles.subtitle}>Task {taskId} &middot; {trace.startedAt}</div>
        </div>
      </div>

      {/* Summary cards */}
      <div style={styles.summaryGrid}>
        <div style={styles.summaryItem}>
          <div style={styles.summaryLabel}>Duration</div>
          <div style={styles.summaryValue}>{formatDuration(trace.totalDurationMs)}</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={styles.summaryLabel}>Spans</div>
          <div style={styles.summaryValue}>{spanCount}</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={styles.summaryLabel}>Model Calls</div>
          <div style={styles.summaryValue}>{modelCalls}</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={styles.summaryLabel}>Tool Calls</div>
          <div style={styles.summaryValue}>{toolCalls}</div>
        </div>
        <div style={styles.summaryItem}>
          <div style={styles.summaryLabel}>Total Cost</div>
          <div style={styles.summaryValue}>${totalCost.toFixed(4)}</div>
        </div>
        {violations > 0 && (
          <div style={{ ...styles.summaryItem, borderColor: '#e74c3c', borderWidth: 1, borderStyle: 'solid' }}>
            <div style={{ ...styles.summaryLabel, color: '#e74c3c' }}>Violations</div>
            <div style={{ ...styles.summaryValue, color: '#e74c3c' }}>{violations}</div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={styles.legend}>
        {LEGEND_ITEMS.map(item => (
          <div key={item.label} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, backgroundColor: item.color }} />
            {item.label}
          </div>
        ))}
      </div>

      {/* Gantt Chart */}
      <div style={styles.card}>
        <GanttChart
          spans={trace.spans}
          traceStartTime={traceStartTime}
          totalDurationMs={trace.totalDurationMs}
          onSpanClick={setSelectedSpan}
          selectedSpanId={selectedSpan?.id}
        />
      </div>

      {/* Span detail panel */}
      {selectedSpan && (
        <SpanDetail span={selectedSpan} onClose={() => setSelectedSpan(null)} />
      )}
    </div>
  );
}
