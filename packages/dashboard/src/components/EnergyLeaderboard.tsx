import React from 'react';
import { useTasks } from '../hooks/useTasks.ts';
import { EnergyBadge } from './EnergyBadge.tsx';

const styles = {
  container: { marginBottom: 16 } as React.CSSProperties,
  title: { fontSize: 16, fontWeight: 600, marginBottom: 16, color: '#4ecdc4' } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' as const } as React.CSSProperties,
  th: { textAlign: 'left' as const, padding: '10px 12px', borderBottom: '2px solid #222', color: '#888', fontSize: 12, textTransform: 'uppercase' as const } as React.CSSProperties,
  td: { padding: '10px 12px', borderBottom: '1px solid #1a1a2e', fontSize: 13 } as React.CSSProperties,
  rank: { fontWeight: 700, color: '#4ecdc4' } as React.CSSProperties,
  empty: { textAlign: 'center' as const, padding: 32, color: '#666', fontSize: 14 } as React.CSSProperties,
};

interface RankedTask {
  id: string;
  tokens: number;
  energyWh: number;
  efficiency: number;
  carbonGrams?: number;
}

function getEfficiencyRating(efficiency: number): string {
  if (efficiency < 0.0001) return 'excellent';
  if (efficiency < 0.001) return 'good';
  if (efficiency < 0.01) return 'fair';
  return 'poor';
}

export function EnergyLeaderboard() {
  const { tasks } = useTasks();

  const completedTasks = tasks.filter((t: any) => t.status === 'completed');

  const ranked: RankedTask[] = completedTasks
    .filter((t: any) => {
      const b = t.budgetUsed || {};
      return b.energyWh && b.totalTokens && b.totalTokens > 0;
    })
    .map((t: any) => {
      const b = t.budgetUsed;
      return {
        id: t.taskId || t.id,
        tokens: b.totalTokens,
        energyWh: b.energyWh,
        efficiency: b.energyWh / b.totalTokens,
        carbonGrams: b.carbonGrams,
      };
    })
    .sort((a: RankedTask, b: RankedTask) => a.efficiency - b.efficiency)
    .slice(0, 10);

  if (ranked.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>Energy Efficiency Leaderboard</div>
        <div style={styles.empty}>No completed tasks with energy data</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.title}>Energy Efficiency Leaderboard</div>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Rank</th>
            <th style={styles.th}>Task ID</th>
            <th style={styles.th}>Tokens</th>
            <th style={styles.th}>Energy (Wh)</th>
            <th style={styles.th}>Wh/Token</th>
            <th style={styles.th}>Rating</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((task, index) => (
            <tr key={task.id}>
              <td style={{ ...styles.td, ...styles.rank }}>#{index + 1}</td>
              <td style={styles.td} title={task.id}>
                {task.id.slice(0, 12)}...
              </td>
              <td style={styles.td}>{task.tokens.toLocaleString()}</td>
              <td style={styles.td}>{task.energyWh.toFixed(4)}</td>
              <td style={styles.td}>{task.efficiency.toFixed(6)}</td>
              <td style={styles.td}>
                <EnergyBadge energyWh={task.energyWh} carbonGrams={task.carbonGrams} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
