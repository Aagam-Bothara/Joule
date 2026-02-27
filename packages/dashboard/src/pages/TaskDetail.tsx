import React, { useEffect, useState } from 'react';
import { useTask } from '../hooks/useTasks.ts';
import { TraceTree } from '../components/TraceTree.tsx';
import { BudgetGauge } from '../components/BudgetGauge.tsx';
import { EnergyBadge } from '../components/EnergyBadge.tsx';
import { CanvasViewer } from '../components/CanvasViewer.tsx';
import { fetchArtifactHtml } from '../api/client.ts';

const styles = {
  backButton: { padding: '6px 12px', background: '#333', border: 'none', borderRadius: 6, color: '#ccc', cursor: 'pointer', fontSize: 13, marginBottom: 16, display: 'inline-block' } as React.CSSProperties,
  header: { marginBottom: 24 } as React.CSSProperties,
  title: { fontSize: 20, fontWeight: 700, marginBottom: 8 } as React.CSSProperties,
  meta: { color: '#888', fontSize: 13 } as React.CSSProperties,
  section: { marginBottom: 24 } as React.CSSProperties,
  sectionTitle: { fontSize: 16, fontWeight: 600, marginBottom: 12, color: '#4ecdc4' } as React.CSSProperties,
  synthesis: { padding: 16, background: '#111118', borderRadius: 8, border: '1px solid #222', whiteSpace: 'pre-wrap' as const, lineHeight: 1.6 } as React.CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 24 } as React.CSSProperties,
  card: { padding: 16, background: '#111118', borderRadius: 8, border: '1px solid #222' } as React.CSSProperties,
  cardLabel: { fontSize: 12, color: '#666', marginBottom: 4 } as React.CSSProperties,
  cardValue: { fontSize: 18, fontWeight: 600 } as React.CSSProperties,
  stepList: { listStyle: 'none', padding: 0 } as React.CSSProperties,
  step: { padding: '8px 12px', marginBottom: 4, borderRadius: 6, background: '#111118', border: '1px solid #222', fontSize: 13 } as React.CSSProperties,
  stepSuccess: { borderLeft: '3px solid #4ecdc4' } as React.CSSProperties,
  stepFailed: { borderLeft: '3px solid #ff6b6b' } as React.CSSProperties,
  error: { color: '#ff6b6b', padding: 16, background: '#2a1a1a', borderRadius: 8 } as React.CSSProperties,
  empty: { textAlign: 'center' as const, padding: 48, color: '#666' } as React.CSSProperties,
};

interface TaskDetailProps {
  taskId: string | null;
  onBack: () => void;
}

export function TaskDetail({ taskId, onBack }: TaskDetailProps) {
  const { task, loading, error } = useTask(taskId);
  const [canvasArtifacts, setCanvasArtifacts] = useState<Array<{ id: string; title: string; html: string }>>([]);

  useEffect(() => {
    if (!task?.stepResults) return;
    const ids = task.stepResults
      .filter((s: any) => s.toolName?.startsWith('canvas_') && s.output?.artifactId)
      .map((s: any) => s.output.artifactId as string);
    const unique = [...new Set(ids)];
    if (unique.length === 0) { setCanvasArtifacts([]); return; }

    Promise.all(unique.map(async (id) => {
      try {
        const html = await fetchArtifactHtml(id);
        return { id, title: task.stepResults.find((s: any) => s.output?.artifactId === id)?.output?.title || 'Canvas', html };
      } catch { return null; }
    })).then(results => setCanvasArtifacts(results.filter(Boolean) as any));
  }, [task]);

  if (!taskId) {
    return <div style={styles.empty}>No task selected</div>;
  }

  if (loading) {
    return <div style={styles.empty}>Loading task...</div>;
  }

  if (error) {
    return <div style={styles.error}>{error}</div>;
  }

  if (!task) {
    return <div style={styles.empty}>Task not found</div>;
  }

  const budget = task.budgetUsed || {};

  return (
    <div>
      <button style={styles.backButton} onClick={onBack}>Back to Tasks</button>

      <div style={styles.header}>
        <div style={styles.title}>Task {(task.taskId || task.id || '').slice(0, 16)}</div>
        <div style={styles.meta}>
          Status: {task.status} | Completed: {task.completedAt || '—'}
        </div>
      </div>

      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Tokens</div>
          <div style={styles.cardValue}>{budget.totalTokens?.toLocaleString() || '—'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Cost</div>
          <div style={styles.cardValue}>{budget.costUsd ? `$${budget.costUsd.toFixed(4)}` : '—'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Latency</div>
          <div style={styles.cardValue}>{budget.latencyMs ? `${budget.latencyMs}ms` : '—'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Energy</div>
          <div style={styles.cardValue}>
            {budget.energyWh !== undefined ? (
              <EnergyBadge energyWh={budget.energyWh} carbonGrams={budget.carbonGrams} />
            ) : '—'}
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Tool Calls</div>
          <div style={styles.cardValue}>{budget.toolCalls ?? '—'}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Escalations</div>
          <div style={styles.cardValue}>{budget.escalations ?? '—'}</div>
        </div>
      </div>

      {budget.totalTokens !== undefined && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Budget Usage</div>
          <BudgetGauge budget={budget} />
        </div>
      )}

      {task.synthesis && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Synthesis</div>
          <div style={styles.synthesis}>{task.synthesis}</div>
        </div>
      )}

      {canvasArtifacts.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Canvas Output</div>
          {canvasArtifacts.map(a => (
            <CanvasViewer key={a.id} html={a.html} title={a.title} artifactId={a.id} />
          ))}
        </div>
      )}

      {task.stepResults && task.stepResults.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Steps ({task.stepResults.length})</div>
          <ul style={styles.stepList}>
            {task.stepResults.map((step: any, i: number) => (
              <li key={i} style={{ ...styles.step, ...(step.success ? styles.stepSuccess : styles.stepFailed) }}>
                <strong>{step.toolName}</strong> — {step.success ? 'Success' : `Failed: ${step.error}`}
                {step.output && (
                  <pre style={{ fontSize: 11, color: '#888', marginTop: 4, overflow: 'auto', maxHeight: 100 }}>
                    {JSON.stringify(step.output, null, 2).slice(0, 500)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {task.trace && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Execution Trace</div>
          <TraceTree spans={task.trace.spans || []} />
        </div>
      )}
    </div>
  );
}
