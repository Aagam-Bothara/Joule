import React, { useState } from 'react';

const styles = {
  span: { marginLeft: 16, borderLeft: '2px solid #333', paddingLeft: 12, marginBottom: 8 } as React.CSSProperties,
  spanHeader: { cursor: 'pointer', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties,
  spanName: { fontWeight: 600, color: '#4ecdc4' } as React.CSSProperties,
  duration: { color: '#666', fontSize: 12 } as React.CSSProperties,
  event: { fontSize: 12, padding: '2px 0 2px 24px', color: '#888' } as React.CSSProperties,
  eventType: { color: '#c9a', fontWeight: 500 } as React.CSSProperties,
};

interface TraceSpan {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  children: TraceSpan[];
}

export function TraceTree({ spans }: { spans: TraceSpan[] }) {
  return (
    <div>
      {spans.map(span => (
        <SpanNode key={span.id} span={span} />
      ))}
    </div>
  );
}

function SpanNode({ span }: { span: TraceSpan }) {
  const [expanded, setExpanded] = useState(true);
  const duration = span.endTime ? `${span.endTime - span.startTime}ms` : 'running...';

  return (
    <div style={styles.span}>
      <div style={styles.spanHeader} onClick={() => setExpanded(!expanded)}>
        <span>{expanded ? '▾' : '▸'}</span>
        <span style={styles.spanName}>{span.name}</span>
        <span style={styles.duration}>{duration}</span>
      </div>
      {expanded && (
        <>
          {span.events.map((evt, i) => (
            <div key={i} style={styles.event}>
              <span style={styles.eventType}>{evt.type}</span>
              {' '}
              {JSON.stringify(evt.data).slice(0, 120)}
            </div>
          ))}
          {span.children.map(child => (
            <SpanNode key={child.id} span={child} />
          ))}
        </>
      )}
    </div>
  );
}
