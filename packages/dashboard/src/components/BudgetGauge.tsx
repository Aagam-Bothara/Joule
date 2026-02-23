import React from 'react';

const styles = {
  container: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 } as React.CSSProperties,
  gauge: { padding: 12, background: '#0d0d14', borderRadius: 6, border: '1px solid #222' } as React.CSSProperties,
  label: { fontSize: 11, color: '#666', marginBottom: 6, textTransform: 'uppercase' as const } as React.CSSProperties,
  barOuter: { height: 8, background: '#1a1a2e', borderRadius: 4, overflow: 'hidden', marginBottom: 4 } as React.CSSProperties,
  barInner: (pct: number, color: string) => ({
    height: '100%',
    width: `${Math.min(100, pct)}%`,
    background: color,
    borderRadius: 4,
    transition: 'width 0.3s',
  } as React.CSSProperties),
  value: { fontSize: 12, fontWeight: 600 } as React.CSSProperties,
};

interface BudgetGaugeProps {
  budget: {
    totalTokens?: number;
    costUsd?: number;
    latencyMs?: number;
    toolCalls?: number;
    escalations?: number;
    energyWh?: number;
    carbonGrams?: number;
  };
  limits?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxLatencyMs?: number;
    maxToolCalls?: number;
    maxEscalations?: number;
    maxEnergyWh?: number;
    maxCarbonGrams?: number;
  };
}

const dimensions = [
  { key: 'totalTokens', limitKey: 'maxTokens', label: 'Tokens', color: '#4ecdc4', defaultLimit: 50000, format: (v: number) => v.toLocaleString() },
  { key: 'costUsd', limitKey: 'maxCostUsd', label: 'Cost', color: '#f0c040', defaultLimit: 0.5, format: (v: number) => `$${v.toFixed(4)}` },
  { key: 'latencyMs', limitKey: 'maxLatencyMs', label: 'Latency', color: '#7b68ee', defaultLimit: 30000, format: (v: number) => `${v}ms` },
  { key: 'toolCalls', limitKey: 'maxToolCalls', label: 'Tool Calls', color: '#ff8c42', defaultLimit: 10, format: (v: number) => String(v) },
  { key: 'escalations', limitKey: 'maxEscalations', label: 'Escalations', color: '#ff6b6b', defaultLimit: 3, format: (v: number) => String(v) },
  { key: 'energyWh', limitKey: 'maxEnergyWh', label: 'Energy', color: '#50fa7b', defaultLimit: 0.01, format: (v: number) => `${v.toFixed(4)} Wh` },
  { key: 'carbonGrams', limitKey: 'maxCarbonGrams', label: 'Carbon', color: '#bd93f9', defaultLimit: 0.005, format: (v: number) => `${v.toFixed(4)} g` },
];

export function BudgetGauge({ budget, limits }: BudgetGaugeProps) {
  return (
    <div style={styles.container}>
      {dimensions.map(dim => {
        const value = (budget as any)[dim.key] ?? 0;
        const limit = (limits as any)?.[dim.limitKey] ?? dim.defaultLimit;
        const pct = limit > 0 ? (value / limit) * 100 : 0;
        const barColor = pct > 90 ? '#ff6b6b' : pct > 70 ? '#f0c040' : dim.color;

        return (
          <div key={dim.key} style={styles.gauge}>
            <div style={styles.label}>{dim.label}</div>
            <div style={styles.barOuter}>
              <div style={styles.barInner(pct, barColor)} />
            </div>
            <div style={styles.value}>
              {dim.format(value)}
              <span style={{ color: '#444', fontWeight: 400 }}> / {dim.format(limit)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
