import React from 'react';
import { BudgetGauge } from './BudgetGauge.tsx';
import { useBudgetStream, type BudgetUpdate } from '../hooks/useBudgetStream.ts';

interface LiveBudgetGaugeProps {
  taskId: string | null;
  /** Static budget data (used when not streaming) */
  staticBudget?: Record<string, number>;
  staticLimits?: Record<string, number>;
}

const styles = {
  container: { marginTop: 16 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  title: { fontSize: 14, fontWeight: 600, color: '#ddd' },
  liveIndicator: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#2ecc71',
    animation: 'pulse 1.5s infinite',
  },
  disconnected: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: '#666',
  },
  agentLabel: {
    fontSize: 12,
    color: '#4ecdc4',
    marginBottom: 6,
    marginTop: 12,
    fontWeight: 600,
  },
};

function latestBudgetToGaugeProps(update: BudgetUpdate) {
  return {
    budget: {
      totalTokens: update.usage.totalTokens ?? 0,
      costUsd: update.usage.costUsd ?? 0,
      latencyMs: update.usage.latencyMs ?? 0,
      toolCalls: update.usage.toolCalls ?? 0,
      escalations: update.usage.escalations ?? 0,
      energyWh: update.usage.energyWh ?? 0,
      carbonGrams: update.usage.carbonGrams ?? 0,
    },
  };
}

export function LiveBudgetGauge({ taskId, staticBudget, staticLimits }: LiveBudgetGaugeProps) {
  const { budgetUpdates, agentBudgets, connected } = useBudgetStream(taskId);

  // If we have live streaming data, use it
  if (budgetUpdates.length > 0) {
    const latest = budgetUpdates[budgetUpdates.length - 1];

    // Multi-agent: show per-agent gauges
    if (agentBudgets.size > 1) {
      return (
        <div style={styles.container}>
          <div style={styles.header}>
            <div style={connected ? styles.liveIndicator : styles.disconnected} />
            <div style={styles.title}>Live Budget ({agentBudgets.size} agents)</div>
          </div>
          {Array.from(agentBudgets.entries()).map(([agentId, update]) => (
            <div key={agentId}>
              <div style={styles.agentLabel}>{update.agentRole ?? agentId}</div>
              <BudgetGauge {...latestBudgetToGaugeProps(update)} />
            </div>
          ))}
        </div>
      );
    }

    // Single agent: show one gauge
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={connected ? styles.liveIndicator : styles.disconnected} />
          <div style={styles.title}>Live Budget</div>
        </div>
        <BudgetGauge {...latestBudgetToGaugeProps(latest)} />
      </div>
    );
  }

  // Fall back to static data
  if (staticBudget) {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.title}>Budget Usage</div>
        </div>
        <BudgetGauge budget={staticBudget} limits={staticLimits} />
      </div>
    );
  }

  return null;
}
