import React from 'react';
import { useTasks } from '../hooks/useTasks.ts';
import { useHealth } from '../hooks/useHealth.ts';
import { EnergyBadge } from '../components/EnergyBadge.tsx';
import { ToolUsageChart } from '../components/ToolUsageChart.tsx';
import { SystemHealth } from '../components/SystemHealth.tsx';
import { EnergyLeaderboard } from '../components/EnergyLeaderboard.tsx';

const styles = {
  title: { fontSize: 24, fontWeight: 700, marginBottom: 24 } as React.CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 32 } as React.CSSProperties,
  card: { padding: 20, background: '#111118', borderRadius: 8, border: '1px solid #222' } as React.CSSProperties,
  cardLabel: { fontSize: 12, color: '#666', marginBottom: 8, textTransform: 'uppercase' as const } as React.CSSProperties,
  cardValue: { fontSize: 28, fontWeight: 700 } as React.CSSProperties,
  cardSub: { fontSize: 12, color: '#666', marginTop: 4 } as React.CSSProperties,
  section: { marginBottom: 32 } as React.CSSProperties,
  sectionTitle: { fontSize: 16, fontWeight: 600, marginBottom: 16, color: '#4ecdc4' } as React.CSSProperties,
  bar: { height: 24, borderRadius: 4, marginBottom: 8, display: 'flex', overflow: 'hidden' } as React.CSSProperties,
  barSegment: (color: string, pct: number) => ({
    height: '100%',
    width: `${pct}%`,
    background: color,
    transition: 'width 0.3s',
    minWidth: pct > 0 ? 2 : 0,
  } as React.CSSProperties),
  barLabel: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888', marginBottom: 16 } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' as const } as React.CSSProperties,
  th: { textAlign: 'left' as const, padding: '10px 12px', borderBottom: '2px solid #222', color: '#888', fontSize: 12 } as React.CSSProperties,
  td: { padding: '10px 12px', borderBottom: '1px solid #1a1a2e', fontSize: 13 } as React.CSSProperties,
  empty: { textAlign: 'center' as const, padding: 48, color: '#666' } as React.CSSProperties,
};

export function Analytics() {
  const { tasks, loading } = useTasks();
  const { health } = useHealth();

  const completedTasks = tasks.filter((t: any) => t.status === 'completed');
  const failedTasks = tasks.filter((t: any) => t.status === 'failed');

  const totals = completedTasks.reduce(
    (acc: any, t: any) => {
      const b = t.budgetUsed || {};
      return {
        tokens: acc.tokens + (b.totalTokens || 0),
        cost: acc.cost + (b.costUsd || 0),
        energy: acc.energy + (b.energyWh || 0),
        carbon: acc.carbon + (b.carbonGrams || 0),
        latency: acc.latency + (b.latencyMs || 0),
        toolCalls: acc.toolCalls + (b.toolCalls || 0),
        escalations: acc.escalations + (b.escalations || 0),
      };
    },
    { tokens: 0, cost: 0, energy: 0, carbon: 0, latency: 0, toolCalls: 0, escalations: 0 },
  );

  const successRate = tasks.length > 0
    ? ((completedTasks.length / tasks.length) * 100).toFixed(1)
    : '—';

  const avgCost = completedTasks.length > 0
    ? (totals.cost / completedTasks.length).toFixed(4)
    : '—';

  const avgLatency = completedTasks.length > 0
    ? Math.round(totals.latency / completedTasks.length)
    : 0;

  if (loading) {
    return <div style={styles.empty}>Loading analytics...</div>;
  }

  return (
    <div>
      <h1 style={styles.title}>Analytics</h1>

      <div style={styles.grid}>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Tasks</div>
          <div style={styles.cardValue}>{tasks.length}</div>
          <div style={styles.cardSub}>{completedTasks.length} completed, {failedTasks.length} failed</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Success Rate</div>
          <div style={styles.cardValue}>{successRate}%</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Tokens</div>
          <div style={styles.cardValue}>{totals.tokens.toLocaleString()}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Cost</div>
          <div style={styles.cardValue}>${totals.cost.toFixed(4)}</div>
          <div style={styles.cardSub}>Avg: ${avgCost}/task</div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Total Energy</div>
          <div style={styles.cardValue}>
            <EnergyBadge energyWh={totals.energy} carbonGrams={totals.carbon} />
          </div>
        </div>
        <div style={styles.card}>
          <div style={styles.cardLabel}>Avg Latency</div>
          <div style={styles.cardValue}>{avgLatency}ms</div>
        </div>
      </div>

      {health && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>System Health</div>
          <div style={styles.grid}>
            <div style={styles.card}>
              <div style={styles.cardLabel}>Status</div>
              <div style={{ ...styles.cardValue, color: health.status === 'healthy' ? '#4ecdc4' : '#ff6b6b' }}>
                {health.status}
              </div>
            </div>
            <div style={styles.card}>
              <div style={styles.cardLabel}>Providers</div>
              <div style={styles.cardValue}>{health.providers?.length || 0}</div>
            </div>
            <div style={styles.card}>
              <div style={styles.cardLabel}>Tools</div>
              <div style={styles.cardValue}>{health.tools?.length || 0}</div>
            </div>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Task Breakdown</div>
          <div style={styles.bar}>
            <div style={styles.barSegment('#4ecdc4', (completedTasks.length / tasks.length) * 100)} />
            <div style={styles.barSegment('#ff6b6b', (failedTasks.length / tasks.length) * 100)} />
            <div style={styles.barSegment('#f0c040', ((tasks.length - completedTasks.length - failedTasks.length) / tasks.length) * 100)} />
          </div>
          <div style={styles.barLabel}>
            <span>Completed: {completedTasks.length}</span>
            <span>Failed: {failedTasks.length}</span>
            <span>Other: {tasks.length - completedTasks.length - failedTasks.length}</span>
          </div>
        </div>
      )}

      {completedTasks.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Budget Summary (7 Dimensions)</div>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Dimension</th>
                <th style={styles.th}>Total</th>
                <th style={styles.th}>Average</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={styles.td}>Tokens</td>
                <td style={styles.td}>{totals.tokens.toLocaleString()}</td>
                <td style={styles.td}>{Math.round(totals.tokens / completedTasks.length).toLocaleString()}</td>
              </tr>
              <tr>
                <td style={styles.td}>Cost (USD)</td>
                <td style={styles.td}>${totals.cost.toFixed(4)}</td>
                <td style={styles.td}>${(totals.cost / completedTasks.length).toFixed(4)}</td>
              </tr>
              <tr>
                <td style={styles.td}>Latency (ms)</td>
                <td style={styles.td}>{totals.latency.toLocaleString()}</td>
                <td style={styles.td}>{avgLatency.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={styles.td}>Tool Calls</td>
                <td style={styles.td}>{totals.toolCalls}</td>
                <td style={styles.td}>{(totals.toolCalls / completedTasks.length).toFixed(1)}</td>
              </tr>
              <tr>
                <td style={styles.td}>Escalations</td>
                <td style={styles.td}>{totals.escalations}</td>
                <td style={styles.td}>{(totals.escalations / completedTasks.length).toFixed(1)}</td>
              </tr>
              <tr>
                <td style={styles.td}>Energy (Wh)</td>
                <td style={styles.td}>{totals.energy.toFixed(4)}</td>
                <td style={styles.td}>{(totals.energy / completedTasks.length).toFixed(4)}</td>
              </tr>
              <tr>
                <td style={styles.td}>Carbon (gCO2)</td>
                <td style={styles.td}>{totals.carbon.toFixed(4)}</td>
                <td style={styles.td}>{(totals.carbon / completedTasks.length).toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div style={styles.section}>
        <ToolUsageChart
          tools={
            health?.tools?.map((t: any) => ({
              name: t.name || t,
              callCount: t.callCount || 0,
            })) || []
          }
        />
      </div>

      <div style={styles.section}>
        <SystemHealth />
      </div>

      <div style={styles.section}>
        <EnergyLeaderboard />
      </div>
    </div>
  );
}
