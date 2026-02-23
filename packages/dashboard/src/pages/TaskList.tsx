import React, { useState, useMemo } from 'react';
import { useTasks } from '../hooks/useTasks.ts';
import { EnergyBadge } from '../components/EnergyBadge.tsx';
import { submitTask } from '../api/client.ts';
import { TaskFilter, FilterState } from '../components/TaskFilter.tsx';

const styles = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 } as React.CSSProperties,
  title: { fontSize: 24, fontWeight: 700 } as React.CSSProperties,
  submitForm: { display: 'flex', gap: 8 } as React.CSSProperties,
  input: { flex: 1, padding: '8px 12px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#e0e0e0', fontSize: 14 } as React.CSSProperties,
  select: { padding: '8px 12px', background: '#1a1a2e', border: '1px solid #333', borderRadius: 6, color: '#e0e0e0', fontSize: 14 } as React.CSSProperties,
  button: { padding: '8px 16px', background: '#4ecdc4', border: 'none', borderRadius: 6, color: '#000', fontWeight: 600, cursor: 'pointer', fontSize: 14 } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' as const, marginTop: 16 } as React.CSSProperties,
  th: { textAlign: 'left' as const, padding: '12px 16px', borderBottom: '2px solid #222', color: '#888', fontSize: 12, textTransform: 'uppercase' as const } as React.CSSProperties,
  td: { padding: '12px 16px', borderBottom: '1px solid #1a1a2e', fontSize: 14 } as React.CSSProperties,
  row: { cursor: 'pointer', transition: 'background 0.15s' } as React.CSSProperties,
  statusBadge: (status: string) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    background: status === 'completed' ? '#1a3a2a' : status === 'failed' ? '#3a1a1a' : '#2a2a1a',
    color: status === 'completed' ? '#4ecdc4' : status === 'failed' ? '#ff6b6b' : '#f0c040',
  } as React.CSSProperties),
  empty: { textAlign: 'center' as const, padding: 48, color: '#666' } as React.CSSProperties,
  error: { color: '#ff6b6b', padding: 16, background: '#2a1a1a', borderRadius: 8, marginBottom: 16 } as React.CSSProperties,
};

interface TaskListProps {
  onSelectTask: (id: string) => void;
}

export function TaskList({ onSelectTask }: TaskListProps) {
  const { tasks, loading, error, refresh } = useTasks();
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState<FilterState>({ search: '', status: 'all', sort: 'newest' });

  const filteredTasks = useMemo(() => {
    let result = [...tasks];

    // Filter by search
    if (filter.search) {
      const q = filter.search.toLowerCase();
      result = result.filter((t: any) => {
        const id = (t.taskId || t.id || '').toLowerCase();
        const desc = (t.description || '').toLowerCase();
        return id.includes(q) || desc.includes(q);
      });
    }

    // Filter by status
    if (filter.status !== 'all') {
      result = result.filter((t: any) => t.status === filter.status);
    }

    // Sort
    result.sort((a: any, b: any) => {
      switch (filter.sort) {
        case 'oldest':
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        case 'newest':
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        case 'most_tokens':
          return (b.budgetUsed?.totalTokens || 0) - (a.budgetUsed?.totalTokens || 0);
        case 'least_tokens':
          return (a.budgetUsed?.totalTokens || 0) - (b.budgetUsed?.totalTokens || 0);
        default:
          return 0;
      }
    });

    return result;
  }, [tasks, filter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setSubmitting(true);
    try {
      const result = await submitTask(description, budget);
      setDescription('');
      refresh();
      if (result.taskId) {
        onSelectTask(result.taskId);
      }
    } catch {
      // Error handling done by API client
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.title}>Tasks</h1>
        <button onClick={refresh} style={{ ...styles.button, background: '#333', color: '#ccc' }}>
          Refresh
        </button>
      </div>

      <form style={styles.submitForm} onSubmit={handleSubmit}>
        <input
          style={styles.input}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Describe a task..."
          disabled={submitting}
        />
        <select style={styles.select} value={budget} onChange={e => setBudget(e.target.value)}>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="maximum">Maximum</option>
        </select>
        <button type="submit" style={styles.button} disabled={submitting}>
          {submitting ? 'Running...' : 'Run Task'}
        </button>
      </form>

      {error && <div style={styles.error}>{error}</div>}

      <TaskFilter onFilterChange={setFilter} />

      {loading ? (
        <div style={styles.empty}>Loading tasks...</div>
      ) : filteredTasks.length === 0 ? (
        <div style={styles.empty}>
          {tasks.length === 0
            ? 'No tasks yet. Submit one above to get started.'
            : 'No tasks match the current filters.'}
        </div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>ID</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Budget</th>
              <th style={styles.th}>Tokens</th>
              <th style={styles.th}>Cost</th>
              <th style={styles.th}>Energy</th>
              <th style={styles.th}>Time</th>
            </tr>
          </thead>
          <tbody>
            {filteredTasks.map((task: any) => (
              <tr
                key={task.id || task.taskId}
                style={styles.row}
                onClick={() => onSelectTask(task.taskId || task.id)}
                onMouseOver={e => (e.currentTarget.style.background = '#1a1a2e')}
                onMouseOut={e => (e.currentTarget.style.background = '')}
              >
                <td style={styles.td}>{(task.taskId || task.id || '').slice(0, 12)}...</td>
                <td style={styles.td}>
                  <span style={styles.statusBadge(task.status)}>{task.status}</span>
                </td>
                <td style={styles.td}>{task.budgetUsed?.preset || '—'}</td>
                <td style={styles.td}>{task.budgetUsed?.totalTokens?.toLocaleString() || '—'}</td>
                <td style={styles.td}>{task.budgetUsed?.costUsd ? `$${task.budgetUsed.costUsd.toFixed(4)}` : '—'}</td>
                <td style={styles.td}>
                  {task.budgetUsed?.energyWh !== undefined ? (
                    <EnergyBadge energyWh={task.budgetUsed.energyWh} carbonGrams={task.budgetUsed.carbonGrams} />
                  ) : '—'}
                </td>
                <td style={styles.td}>{task.budgetUsed?.latencyMs ? `${task.budgetUsed.latencyMs}ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
