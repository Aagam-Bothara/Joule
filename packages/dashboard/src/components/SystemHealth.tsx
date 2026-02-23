import React, { useState, useEffect } from 'react';
import { useHealth } from '../hooks/useHealth.ts';
import { fetchMetrics } from '../api/client.ts';

const styles = {
  container: { marginBottom: 16 } as React.CSSProperties,
  title: { fontSize: 16, fontWeight: 600, marginBottom: 16, color: '#4ecdc4' } as React.CSSProperties,
  card: { padding: 20, background: '#111118', borderRadius: 8, border: '1px solid #222' } as React.CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 } as React.CSSProperties,
  metricLabel: { fontSize: 12, color: '#666', marginBottom: 6, textTransform: 'uppercase' as const } as React.CSSProperties,
  metricValue: { fontSize: 22, fontWeight: 700, color: '#e0e0e0' } as React.CSSProperties,
  metricUnit: { fontSize: 12, color: '#888', marginLeft: 4 } as React.CSSProperties,
  empty: { textAlign: 'center' as const, padding: 32, color: '#666', fontSize: 14 } as React.CSSProperties,
};

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb.toFixed(1);
}

export function SystemHealth() {
  const { health } = useHealth();
  const [metrics, setMetrics] = useState<any>(null);

  useEffect(() => {
    const load = () => {
      fetchMetrics()
        .then(setMetrics)
        .catch(() => setMetrics(null));
    };

    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  const uptime = metrics?.uptime ?? health?.uptime ?? 0;
  const memoryRss = metrics?.memory?.rss ?? health?.memory?.rss ?? 0;
  const activeTasks = metrics?.activeTasks ?? health?.activeTasks ?? 0;

  if (!health && !metrics) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>System Health</div>
        <div style={styles.empty}>No health data available</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.title}>System Health</div>
      <div style={styles.card}>
        <div style={styles.grid}>
          <div>
            <div style={styles.metricLabel}>Uptime</div>
            <div style={styles.metricValue}>
              {formatUptime(uptime)}
            </div>
          </div>
          <div>
            <div style={styles.metricLabel}>Memory (RSS)</div>
            <div style={styles.metricValue}>
              {formatMemory(memoryRss)}
              <span style={styles.metricUnit}>MB</span>
            </div>
          </div>
          <div>
            <div style={styles.metricLabel}>Active Tasks</div>
            <div style={styles.metricValue}>
              {activeTasks}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
