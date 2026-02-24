import { describe, it, expect, beforeEach } from 'vitest';
import { TraceRepository } from '../src/repositories/trace.repository.js';
import { freshDb } from './helpers.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: TraceRepository;

beforeEach(() => {
  db = freshDb();
  repo = new TraceRepository(db);
});

function sampleTrace() {
  return {
    traceId: 'trace-001',
    taskId: 'task-001',
    startedAt: '2024-01-01T00:00:00Z',
    completedAt: '2024-01-01T00:01:00Z',
    durationMs: 60000,
    budgetAllocated: { maxTokens: 1000 },
    budgetUsed: { tokens: 500 },
    spans: [
      {
        id: 'span-001',
        traceId: 'trace-001',
        name: 'plan',
        startTime: 1704067200000,
        endTime: 1704067230000,
        events: [
          {
            id: 'evt-001',
            traceId: 'trace-001',
            spanId: 'span-001',
            type: 'llm_call',
            timestamp: 1704067200000,
            wallClock: '2024-01-01T00:00:00Z',
            duration: 500,
            data: { model: 'gpt-4' },
          },
        ],
        children: [
          {
            id: 'span-002',
            traceId: 'trace-001',
            name: 'tool_call',
            startTime: 1704067210000,
            endTime: 1704067220000,
            parentSpanId: 'span-001',
            events: [],
            children: [],
          },
        ],
      },
    ],
  };
}

describe('TraceRepository', () => {
  it('saves and loads a trace with spans and events', () => {
    repo.save(sampleTrace());

    const loaded = repo.load('trace-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.traceId).toBe('trace-001');
    expect(loaded!.taskId).toBe('task-001');
    expect(loaded!.durationMs).toBe(60000);
    expect(loaded!.budgetAllocated).toEqual({ maxTokens: 1000 });
    expect(loaded!.budgetUsed).toEqual({ tokens: 500 });
  });

  it('reconstructs span tree from flat rows', () => {
    repo.save(sampleTrace());
    const loaded = repo.load('trace-001')!;

    // Root span
    expect(loaded.spans).toHaveLength(1);
    const root = loaded.spans[0];
    expect(root.name).toBe('plan');
    expect(root.events).toHaveLength(1);
    expect(root.events[0].type).toBe('llm_call');
    expect(root.events[0].data).toEqual({ model: 'gpt-4' });

    // Child span
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe('tool_call');
    expect(root.children[0].parentSpanId).toBe('span-001');
  });

  it('returns null for non-existent trace', () => {
    expect(repo.load('nonexistent')).toBeNull();
  });

  it('getByTaskId returns the trace for a task', () => {
    repo.save(sampleTrace());
    const loaded = repo.getByTaskId('task-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.traceId).toBe('trace-001');
  });

  it('lists traces ordered by started_at DESC', () => {
    repo.save({ ...sampleTrace(), traceId: 'trace-001', startedAt: '2024-01-01T00:00:00Z' });
    repo.save({ ...sampleTrace(), traceId: 'trace-002', taskId: 'task-002', startedAt: '2024-01-02T00:00:00Z' });

    const list = repo.list();
    expect(list).toHaveLength(2);
    expect(list[0].traceId).toBe('trace-002');
  });

  it('deletes a trace and cascades', () => {
    repo.save(sampleTrace());
    expect(repo.delete('trace-001')).toBe(true);
    expect(repo.load('trace-001')).toBeNull();

    // Spans and events should be cascaded
    const spans = db.prepare('SELECT * FROM trace_spans WHERE trace_id = ?').all('trace-001');
    expect(spans).toHaveLength(0);
    const events = db.prepare('SELECT * FROM trace_events WHERE trace_id = ?').all('trace-001');
    expect(events).toHaveLength(0);
  });
});
