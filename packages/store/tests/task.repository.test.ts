import { describe, it, expect, beforeEach } from 'vitest';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { freshDb } from './helpers.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: TaskRepository;

beforeEach(() => {
  db = freshDb();
  repo = new TaskRepository(db);
});

describe('TaskRepository', () => {
  const sampleTask = {
    id: 'task-001',
    description: 'Test task',
    status: 'completed',
    result: { output: 'hello' },
    stepResults: [{ tool: 'shell', success: true }],
    budgetAllocated: { maxTokens: 1000 },
    budgetUsed: { tokens: 500, costUsd: 0.01 },
    error: undefined,
    traceId: 'trace-001',
    createdAt: '2024-01-01T00:00:00Z',
    completedAt: '2024-01-01T00:01:00Z',
  };

  it('saves and retrieves a task by id', () => {
    repo.save(sampleTask);
    const row = repo.getById('task-001');
    expect(row).not.toBeNull();
    expect(row!.id).toBe('task-001');
    expect(row!.description).toBe('Test task');
    expect(row!.status).toBe('completed');
    expect(row!.trace_id).toBe('trace-001');
  });

  it('returns null for non-existent task', () => {
    expect(repo.getById('nonexistent')).toBeNull();
  });

  it('getByIdParsed deserializes JSON fields', () => {
    repo.save(sampleTask);
    const parsed = repo.getByIdParsed('task-001');
    expect(parsed).not.toBeNull();
    expect(parsed!.result).toEqual({ output: 'hello' });
    expect(parsed!.stepResults).toEqual([{ tool: 'shell', success: true }]);
    expect(parsed!.budgetAllocated).toEqual({ maxTokens: 1000 });
    expect(parsed!.budgetUsed).toEqual({ tokens: 500, costUsd: 0.01 });
  });

  it('upserts on save (INSERT OR REPLACE)', () => {
    repo.save(sampleTask);
    repo.save({ ...sampleTask, status: 'failed', error: 'oops' });

    const row = repo.getById('task-001');
    expect(row!.status).toBe('failed');
    expect(row!.error).toBe('oops');
    expect(repo.count()).toBe(1);
  });

  it('lists tasks with options', () => {
    repo.save({ ...sampleTask, id: 'task-001', createdAt: '2024-01-01T00:00:00Z' });
    repo.save({ ...sampleTask, id: 'task-002', createdAt: '2024-01-02T00:00:00Z' });
    repo.save({ ...sampleTask, id: 'task-003', status: 'failed', createdAt: '2024-01-03T00:00:00Z' });

    // Default: desc by created_at
    const all = repo.list();
    expect(all).toHaveLength(3);
    expect(all[0].id).toBe('task-003');

    // Filter by status
    const failed = repo.list({ status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('task-003');

    // Limit + offset
    const page = repo.list({ limit: 1, offset: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].id).toBe('task-002');
  });

  it('updates status', () => {
    repo.save(sampleTask);
    repo.updateStatus('task-001', 'failed', '2024-01-01T00:05:00Z');

    const row = repo.getById('task-001');
    expect(row!.status).toBe('failed');
    expect(row!.completed_at).toBe('2024-01-01T00:05:00Z');
  });

  it('deletes a task', () => {
    repo.save(sampleTask);
    expect(repo.delete('task-001')).toBe(true);
    expect(repo.getById('task-001')).toBeNull();
    expect(repo.delete('task-001')).toBe(false);
  });

  it('counts tasks with optional status filter', () => {
    repo.save({ ...sampleTask, id: 'task-001', status: 'completed' });
    repo.save({ ...sampleTask, id: 'task-002', status: 'failed' });
    repo.save({ ...sampleTask, id: 'task-003', status: 'completed' });

    expect(repo.count()).toBe(3);
    expect(repo.count('completed')).toBe(2);
    expect(repo.count('failed')).toBe(1);
    expect(repo.count('pending')).toBe(0);
  });
});
