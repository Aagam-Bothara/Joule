import React from 'react';
import type { TraceSpan, TraceEvent } from '../hooks/useTrace.ts';

interface SpanDetailProps {
  span: TraceSpan;
  onClose: () => void;
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    top: 0, right: 0, bottom: 0,
    width: 420,
    background: '#111118',
    borderLeft: '1px solid #333',
    overflowY: 'auto' as const,
    zIndex: 100,
    padding: 20,
    boxShadow: '-4px 0 20px rgba(0,0,0,0.5)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    borderBottom: '1px solid #333',
    paddingBottom: 12,
  },
  title: { fontSize: 16, fontWeight: 700, color: '#fff' },
  closeBtn: {
    background: 'none', border: 'none', color: '#999',
    fontSize: 20, cursor: 'pointer', padding: '4px 8px',
  },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 13, fontWeight: 600, color: '#4ecdc4', marginBottom: 8 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 },
  label: { color: '#999' },
  value: { color: '#ddd', fontFamily: 'monospace' },
  eventCard: {
    background: '#1a1a2e',
    borderRadius: 6,
    padding: 12,
    marginBottom: 8,
    border: '1px solid #222',
  },
  eventType: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, marginBottom: 6 },
  jsonBlock: {
    background: '#0d0d14',
    borderRadius: 4,
    padding: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#aaa',
    maxHeight: 200,
    overflowY: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  },
  violation: { borderColor: '#e74c3c', borderWidth: 2 },
  governanceEvent: { borderColor: '#f39c12' },
};

function getEventColor(type: string): string {
  switch (type) {
    case 'model_call': return '#3498db';
    case 'tool_call': return '#2ecc71';
    case 'constitution_violation':
    case 'constitution_output_violation': return '#e74c3c';
    case 'governance_preflight':
    case 'governance_runtime':
    case 'governance_post_task': return '#f39c12';
    case 'routing_decision': return '#9b59b6';
    case 'budget_checkpoint': return '#e67e22';
    case 'energy_report': return '#1abc9c';
    default: return '#95a5a6';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderModelCallEvent(data: Record<string, unknown>) {
  return (
    <>
      <div style={styles.row}>
        <span style={styles.label}>Model</span>
        <span style={styles.value}>{String(data.model ?? '—')}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Provider</span>
        <span style={styles.value}>{String(data.provider ?? '—')}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Tokens</span>
        <span style={styles.value}>
          {String(data.promptTokens ?? 0)} in / {String(data.completionTokens ?? 0)} out
        </span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Cost</span>
        <span style={styles.value}>${Number(data.costUsd ?? 0).toFixed(6)}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Latency</span>
        <span style={styles.value}>{formatDuration(Number(data.latencyMs ?? 0))}</span>
      </div>
    </>
  );
}

function renderToolCallEvent(data: Record<string, unknown>) {
  return (
    <>
      <div style={styles.row}>
        <span style={styles.label}>Tool</span>
        <span style={styles.value}>{String(data.toolName ?? '—')}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Status</span>
        <span style={{ ...styles.value, color: data.success ? '#2ecc71' : '#e74c3c' }}>
          {data.success ? 'Success' : 'Failed'}
        </span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Duration</span>
        <span style={styles.value}>{formatDuration(Number(data.durationMs ?? 0))}</span>
      </div>
      {data.input && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...styles.label, marginBottom: 4 }}>Input:</div>
          <div style={styles.jsonBlock}>
            {typeof data.input === 'string' ? data.input : JSON.stringify(data.input, null, 2)}
          </div>
        </div>
      )}
      {data.error && (
        <div style={{ marginTop: 8 }}>
          <div style={{ ...styles.label, marginBottom: 4, color: '#e74c3c' }}>Error:</div>
          <div style={{ ...styles.jsonBlock, color: '#e74c3c' }}>{String(data.error)}</div>
        </div>
      )}
    </>
  );
}

function renderViolationEvent(data: Record<string, unknown>) {
  return (
    <>
      <div style={styles.row}>
        <span style={styles.label}>Rule</span>
        <span style={{ ...styles.value, color: '#e74c3c' }}>{String(data.ruleText ?? data.rule ?? '—')}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Severity</span>
        <span style={styles.value}>{String(data.severity ?? '—')}</span>
      </div>
    </>
  );
}

function renderGenericEvent(data: Record<string, unknown>) {
  return (
    <div style={styles.jsonBlock}>
      {JSON.stringify(data, null, 2)}
    </div>
  );
}

function renderEvent(event: TraceEvent) {
  const color = getEventColor(event.type);
  const isViolation = event.type.includes('violation');
  const isGovernance = event.type.startsWith('governance_');
  const cardStyle = {
    ...styles.eventCard,
    ...(isViolation ? styles.violation : {}),
    ...(isGovernance ? styles.governanceEvent : {}),
  };

  return (
    <div key={event.id} style={cardStyle}>
      <div style={{ ...styles.eventType, color }}>{event.type.replace(/_/g, ' ')}</div>
      {event.type === 'model_call' && renderModelCallEvent(event.data)}
      {event.type === 'tool_call' && renderToolCallEvent(event.data)}
      {isViolation && renderViolationEvent(event.data)}
      {!['model_call', 'tool_call'].includes(event.type) && !isViolation && renderGenericEvent(event.data)}
    </div>
  );
}

export function SpanDetail({ span, onClose }: SpanDetailProps) {
  const duration = span.endTime ? span.endTime - span.startTime : 0;

  return (
    <div style={styles.overlay}>
      <div style={styles.header}>
        <div style={styles.title}>{span.name}</div>
        <button style={styles.closeBtn} onClick={onClose}>x</button>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Span Info</div>
        <div style={styles.row}>
          <span style={styles.label}>ID</span>
          <span style={styles.value}>{span.id}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Duration</span>
          <span style={styles.value}>{formatDuration(duration)}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Events</span>
          <span style={styles.value}>{span.events.length}</span>
        </div>
        <div style={styles.row}>
          <span style={styles.label}>Children</span>
          <span style={styles.value}>{span.children.length}</span>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionTitle}>Events ({span.events.length})</div>
        {span.events.length === 0 && (
          <div style={{ color: '#666', fontSize: 13 }}>No events recorded</div>
        )}
        {span.events.map(event => renderEvent(event))}
      </div>
    </div>
  );
}
