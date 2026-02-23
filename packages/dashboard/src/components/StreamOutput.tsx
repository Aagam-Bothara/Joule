import React from 'react';

const styles = {
  container: { padding: 16, background: '#111118', borderRadius: 8, border: '1px solid #222', fontFamily: 'monospace', fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' as const, minHeight: 100, position: 'relative' as const } as React.CSSProperties,
  cursor: { display: 'inline-block', width: 8, height: 16, background: '#4ecdc4', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'blink 1s step-end infinite' } as React.CSSProperties,
  label: { position: 'absolute' as const, top: 8, right: 12, fontSize: 11, color: '#666', textTransform: 'uppercase' as const } as React.CSSProperties,
};

interface StreamOutputProps {
  text: string;
  streaming: boolean;
}

export function StreamOutput({ text, streaming }: StreamOutputProps) {
  return (
    <div style={styles.container}>
      <span style={styles.label}>{streaming ? 'Streaming...' : 'Complete'}</span>
      {text}
      {streaming && (
        <>
          <span style={styles.cursor} />
          <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
        </>
      )}
    </div>
  );
}
