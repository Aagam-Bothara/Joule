import React, { useState } from 'react';
import { useTaskStream } from '../hooks/useTaskStream.ts';
import { StreamOutput } from '../components/StreamOutput.tsx';

const styles = {
  title: { fontSize: 24, fontWeight: 700, marginBottom: 24 } as React.CSSProperties,
  form: { display: 'flex', gap: 8, marginBottom: 24 } as React.CSSProperties,
  input: { flex: 1, padding: '10px 14px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#e0e0e0', fontSize: 14 } as React.CSSProperties,
  select: { padding: '10px 14px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#e0e0e0', fontSize: 14 } as React.CSSProperties,
  button: { padding: '10px 20px', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 } as React.CSSProperties,
  startButton: { background: '#4ecdc4', color: '#000' } as React.CSSProperties,
  stopButton: { background: '#ff6b6b', color: '#fff' } as React.CSSProperties,
  progress: { marginBottom: 16 } as React.CSSProperties,
  progressStep: { padding: '6px 12px', marginBottom: 4, borderRadius: 4, background: '#111118', border: '1px solid #222', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 } as React.CSSProperties,
  progressIcon: { width: 20, textAlign: 'center' as const } as React.CSSProperties,
  resultSection: { marginTop: 24, padding: 16, background: '#111118', borderRadius: 8, border: '1px solid #222' } as React.CSSProperties,
  resultTitle: { fontSize: 14, fontWeight: 600, color: '#4ecdc4', marginBottom: 8 } as React.CSSProperties,
  error: { color: '#ff6b6b', padding: 16, background: '#2a1a1a', borderRadius: 8 } as React.CSSProperties,
};

export function LiveStream() {
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('medium');
  const { chunks, fullText, progress, result, streaming, error, startStream, stopStream } = useTaskStream();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() || streaming) return;
    startStream(description, budget);
  };

  return (
    <div>
      <h1 style={styles.title}>Live Stream</h1>

      <form style={styles.form} onSubmit={handleSubmit}>
        <input
          style={styles.input}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Describe a task to stream..."
          disabled={streaming}
        />
        <select style={styles.select} value={budget} onChange={e => setBudget(e.target.value)} disabled={streaming}>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="maximum">Maximum</option>
        </select>
        {streaming ? (
          <button type="button" style={{ ...styles.button, ...styles.stopButton }} onClick={stopStream}>
            Stop
          </button>
        ) : (
          <button type="submit" style={{ ...styles.button, ...styles.startButton }} disabled={!description.trim()}>
            Stream
          </button>
        )}
      </form>

      {error && <div style={styles.error}>{error}</div>}

      {progress.length > 0 && (
        <div style={styles.progress}>
          {progress.map((p, i) => (
            <div key={i} style={styles.progressStep}>
              <span style={styles.progressIcon}>
                {p.status === 'completed' ? '✓' : p.status === 'failed' ? '✗' : '⋯'}
              </span>
              <span>
                Step {p.step}/{p.totalSteps}: {p.description}
                {p.toolName && <span style={{ color: '#666' }}> ({p.toolName})</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {(streaming || fullText) && (
        <StreamOutput text={fullText} streaming={streaming} />
      )}

      {result && (
        <div style={styles.resultSection}>
          <div style={styles.resultTitle}>Completed</div>
          <div style={{ fontSize: 13, color: '#888' }}>
            Status: {result.status} | Tokens: {result.budgetUsed?.totalTokens?.toLocaleString() || '—'} | Cost: {result.budgetUsed?.costUsd ? `$${result.budgetUsed.costUsd.toFixed(4)}` : '—'}
          </div>
        </div>
      )}
    </div>
  );
}
