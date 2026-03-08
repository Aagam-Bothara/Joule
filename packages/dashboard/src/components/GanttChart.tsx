import React, { useMemo } from 'react';
import type { TraceSpan } from '../hooks/useTrace.ts';

interface GanttChartProps {
  spans: TraceSpan[];
  traceStartTime: number;
  totalDurationMs: number;
  onSpanClick?: (span: TraceSpan) => void;
  selectedSpanId?: string;
}

interface FlattenedSpan {
  span: TraceSpan;
  depth: number;
}

const ROW_HEIGHT = 32;
const LABEL_WIDTH = 200;
const BAR_HEIGHT = 20;
const PADDING_TOP = 40;
const MIN_BAR_WIDTH = 4;

const COLORS: Record<string, string> = {
  model_call: '#3498db',
  tool_call: '#2ecc71',
  planning: '#9b59b6',
  execution: '#e67e22',
  specifying: '#f1c40f',
  synthesizing: '#1abc9c',
  verifying: '#e74c3c',
  default: '#4ecdc4',
};

function getSpanColor(span: TraceSpan): string {
  // Check events for the dominant type
  const eventTypes = span.events.map(e => e.type);
  if (eventTypes.includes('model_call')) return COLORS.model_call;
  if (eventTypes.includes('tool_call')) return COLORS.tool_call;

  // Check span name
  const name = span.name.toLowerCase();
  for (const [key, color] of Object.entries(COLORS)) {
    if (name.includes(key)) return color;
  }

  return COLORS.default;
}

function flattenSpans(spans: TraceSpan[], depth = 0): FlattenedSpan[] {
  const result: FlattenedSpan[] = [];
  for (const span of spans) {
    result.push({ span, depth });
    result.push(...flattenSpans(span.children, depth + 1));
  }
  return result;
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function TimeAxis({ width, totalDurationMs }: { width: number; totalDurationMs: number }) {
  const tickCount = Math.min(Math.floor(width / 80), 10);
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => ({
    x: (i / tickCount) * width,
    time: (i / tickCount) * totalDurationMs,
  }));

  return (
    <g>
      <line x1={0} y1={30} x2={width} y2={30} stroke="#333" strokeWidth={1} />
      {ticks.map((tick, i) => (
        <g key={i}>
          <line x1={tick.x} y1={26} x2={tick.x} y2={34} stroke="#555" strokeWidth={1} />
          <text x={tick.x} y={20} fill="#888" fontSize={11} textAnchor="middle" fontFamily="monospace">
            {formatTime(tick.time)}
          </text>
        </g>
      ))}
    </g>
  );
}

export function GanttChart({ spans, traceStartTime, totalDurationMs, onSpanClick, selectedSpanId }: GanttChartProps) {
  const flattened = useMemo(() => flattenSpans(spans), [spans]);
  const chartWidth = 700;
  const chartHeight = PADDING_TOP + flattened.length * ROW_HEIGHT + 20;

  if (totalDurationMs === 0 || flattened.length === 0) {
    return (
      <div style={{ color: '#666', padding: 20, textAlign: 'center' }}>
        No span data available
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={LABEL_WIDTH + chartWidth + 20} height={chartHeight} style={{ display: 'block' }}>
        {/* Labels column */}
        <g>
          {flattened.map(({ span, depth }, i) => (
            <text
              key={`label-${span.id}`}
              x={10 + depth * 12}
              y={PADDING_TOP + i * ROW_HEIGHT + ROW_HEIGHT / 2 + 4}
              fill={selectedSpanId === span.id ? '#4ecdc4' : '#ccc'}
              fontSize={12}
              fontFamily="monospace"
              cursor="pointer"
              onClick={() => onSpanClick?.(span)}
            >
              {span.name.length > 20 ? span.name.slice(0, 18) + '..' : span.name}
            </text>
          ))}
        </g>

        {/* Chart area */}
        <g transform={`translate(${LABEL_WIDTH}, 0)`}>
          <TimeAxis width={chartWidth} totalDurationMs={totalDurationMs} />

          {/* Grid lines */}
          {flattened.map((_, i) => (
            <line
              key={`grid-${i}`}
              x1={0}
              y1={PADDING_TOP + i * ROW_HEIGHT}
              x2={chartWidth}
              y2={PADDING_TOP + i * ROW_HEIGHT}
              stroke="#1a1a2e"
              strokeWidth={1}
            />
          ))}

          {/* Bars */}
          {flattened.map(({ span }, i) => {
            const startOffset = span.startTime - traceStartTime;
            const duration = (span.endTime ?? span.startTime) - span.startTime;
            const x = (startOffset / totalDurationMs) * chartWidth;
            const barWidth = Math.max((duration / totalDurationMs) * chartWidth, MIN_BAR_WIDTH);
            const color = getSpanColor(span);
            const isSelected = selectedSpanId === span.id;

            return (
              <g key={`bar-${span.id}`} cursor="pointer" onClick={() => onSpanClick?.(span)}>
                <rect
                  x={x}
                  y={PADDING_TOP + i * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2}
                  width={barWidth}
                  height={BAR_HEIGHT}
                  rx={3}
                  fill={color}
                  opacity={isSelected ? 1 : 0.8}
                  stroke={isSelected ? '#fff' : 'none'}
                  strokeWidth={isSelected ? 2 : 0}
                />
                {/* Duration label on bar (if wide enough) */}
                {barWidth > 50 && (
                  <text
                    x={x + barWidth / 2}
                    y={PADDING_TOP + i * ROW_HEIGHT + ROW_HEIGHT / 2 + 4}
                    fill="#fff"
                    fontSize={10}
                    textAnchor="middle"
                    fontFamily="monospace"
                    pointerEvents="none"
                  >
                    {formatTime(duration)}
                  </text>
                )}
                {/* Event markers */}
                {span.events
                  .filter(e => e.type === 'constitution_violation' || e.type === 'constitution_output_violation')
                  .map((e, j) => {
                    const evtOffset = e.timestamp - traceStartTime;
                    const evtX = (evtOffset / totalDurationMs) * chartWidth;
                    return (
                      <circle
                        key={`evt-${e.id ?? j}`}
                        cx={evtX}
                        cy={PADDING_TOP + i * ROW_HEIGHT + ROW_HEIGHT / 2}
                        r={5}
                        fill="#e74c3c"
                        stroke="#fff"
                        strokeWidth={1}
                      />
                    );
                  })}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
