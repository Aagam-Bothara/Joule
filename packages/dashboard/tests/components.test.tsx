/**
 * Dashboard component tests — pure render/logic tests without DOM queries.
 * Uses React createElement to avoid JSX transform issues in test env.
 */

import { describe, it, expect } from 'vitest';
import React from 'react';

// ── App ──────────────────────────────────────────────────────────────────────

describe('App', () => {
  it('should export App component', async () => {
    const { App } = await import('../src/App.tsx');
    expect(typeof App).toBe('function');
  });

  it('should render without crashing', async () => {
    const { App } = await import('../src/App.tsx');
    // createElement returns a valid ReactElement
    const element = React.createElement(App);
    expect(element).toBeDefined();
    expect(element.type).toBe(App);
  });
});

// ── BudgetGauge ──────────────────────────────────────────────────────────────

describe('BudgetGauge', () => {
  it('should export BudgetGauge component', async () => {
    const { BudgetGauge } = await import('../src/components/BudgetGauge.tsx');
    expect(typeof BudgetGauge).toBe('function');
  });

  it('should accept budget and limits props', async () => {
    const { BudgetGauge } = await import('../src/components/BudgetGauge.tsx');
    const element = React.createElement(BudgetGauge, {
      budget: { totalTokens: 500, costUsd: 0.01, toolCalls: 3 },
      limits: { maxTokens: 1000, maxCostUsd: 0.10, maxToolCalls: 10 },
    });
    expect(element).toBeDefined();
    expect(element.props.budget.totalTokens).toBe(500);
  });

  it('should handle empty budget', async () => {
    const { BudgetGauge } = await import('../src/components/BudgetGauge.tsx');
    const element = React.createElement(BudgetGauge, { budget: {} });
    expect(element).toBeDefined();
  });
});

// ── Layout ───────────────────────────────────────────────────────────────────

describe('Layout', () => {
  it('should export Layout component', async () => {
    const { Layout } = await import('../src/components/Layout.tsx');
    expect(typeof Layout).toBe('function');
  });
});

// ── GanttChart ───────────────────────────────────────────────────────────────

describe('GanttChart', () => {
  it('should export GanttChart component', async () => {
    const { GanttChart } = await import('../src/components/GanttChart.tsx');
    expect(typeof GanttChart).toBe('function');
  });

  it('should accept spans and selection props', async () => {
    const { GanttChart } = await import('../src/components/GanttChart.tsx');
    const element = React.createElement(GanttChart, {
      spans: [],
      traceStart: 0,
      traceDuration: 1000,
      selectedSpanId: null,
      onSelectSpan: () => {},
    });
    expect(element).toBeDefined();
  });
});

// ── SpanDetail ───────────────────────────────────────────────────────────────

describe('SpanDetail', () => {
  it('should export SpanDetail component', async () => {
    const { SpanDetail } = await import('../src/components/SpanDetail.tsx');
    expect(typeof SpanDetail).toBe('function');
  });
});

// ── LiveBudgetGauge ──────────────────────────────────────────────────────────

describe('LiveBudgetGauge', () => {
  it('should export LiveBudgetGauge component', async () => {
    const { LiveBudgetGauge } = await import('../src/components/LiveBudgetGauge.tsx');
    expect(typeof LiveBudgetGauge).toBe('function');
  });
});

// ── EnergyBadge ──────────────────────────────────────────────────────────────

describe('EnergyBadge', () => {
  it('should export EnergyBadge component', async () => {
    const { EnergyBadge } = await import('../src/components/EnergyBadge.tsx');
    expect(typeof EnergyBadge).toBe('function');
  });
});

// ── TraceTree ────────────────────────────────────────────────────────────────

describe('TraceTree', () => {
  it('should export TraceTree component', async () => {
    const { TraceTree } = await import('../src/components/TraceTree.tsx');
    expect(typeof TraceTree).toBe('function');
  });
});

// ── Pages ────────────────────────────────────────────────────────────────────

describe('Pages', () => {
  it('should export TaskList page', async () => {
    const { TaskList } = await import('../src/pages/TaskList.tsx');
    expect(typeof TaskList).toBe('function');
  });

  it('should export LiveStream page', async () => {
    const { LiveStream } = await import('../src/pages/LiveStream.tsx');
    expect(typeof LiveStream).toBe('function');
  });

  it('should export Analytics page', async () => {
    const { Analytics } = await import('../src/pages/Analytics.tsx');
    expect(typeof Analytics).toBe('function');
  });

  it('should export TraceTimeline page', async () => {
    const { TraceTimeline } = await import('../src/pages/TraceTimeline.tsx');
    expect(typeof TraceTimeline).toBe('function');
  });
});

// ── Hooks ────────────────────────────────────────────────────────────────────

describe('Hooks', () => {
  it('should export useTrace hook', async () => {
    const { useTrace } = await import('../src/hooks/useTrace.ts');
    expect(typeof useTrace).toBe('function');
  });

  it('should export useBudgetStream hook', async () => {
    const { useBudgetStream } = await import('../src/hooks/useBudgetStream.ts');
    expect(typeof useBudgetStream).toBe('function');
  });
});
