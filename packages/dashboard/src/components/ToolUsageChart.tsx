import React from 'react';

const styles = {
  container: { marginBottom: 16 } as React.CSSProperties,
  title: { fontSize: 16, fontWeight: 600, marginBottom: 16, color: '#4ecdc4' } as React.CSSProperties,
  row: { display: 'flex', alignItems: 'center', marginBottom: 8, gap: 12 } as React.CSSProperties,
  label: { width: 140, fontSize: 13, color: '#ccc', textAlign: 'right' as const, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  count: { width: 50, fontSize: 13, color: '#888', textAlign: 'right' as const, flexShrink: 0 } as React.CSSProperties,
  empty: { textAlign: 'center' as const, padding: 32, color: '#666', fontSize: 14 } as React.CSSProperties,
};

interface ToolUsage {
  name: string;
  callCount: number;
}

interface ToolUsageChartProps {
  tools: ToolUsage[];
}

export function ToolUsageChart({ tools }: ToolUsageChartProps) {
  if (!tools || tools.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>Tool Usage</div>
        <div style={styles.empty}>No tool usage data available</div>
      </div>
    );
  }

  const sorted = [...tools].sort((a, b) => b.callCount - a.callCount);
  const maxCount = sorted[0]?.callCount || 1;
  const maxBarWidth = 200;

  return (
    <div style={styles.container}>
      <div style={styles.title}>Tool Usage</div>
      {sorted.map(tool => {
        const barWidth = Math.max(2, (tool.callCount / maxCount) * maxBarWidth);
        return (
          <div key={tool.name} style={styles.row}>
            <div style={styles.label} title={tool.name}>{tool.name}</div>
            <svg width={maxBarWidth} height={20}>
              <rect
                x={0}
                y={2}
                width={barWidth}
                height={16}
                rx={3}
                ry={3}
                fill="#4ecdc4"
              />
            </svg>
            <div style={styles.count}>{tool.callCount}</div>
          </div>
        );
      })}
    </div>
  );
}
