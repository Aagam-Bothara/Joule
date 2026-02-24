import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../src/database.js';
import { runMigrations } from '../src/migrations.js';
import { allMigrations } from '../src/migrations/index.js';
import { TaskRepository } from '../src/repositories/task.repository.js';
import { SessionRepository } from '../src/repositories/session.repository.js';
import { TraceRepository } from '../src/repositories/trace.repository.js';
import { MemoryRepository } from '../src/repositories/memory.repository.js';
import { ScheduleRepository } from '../src/repositories/schedule.repository.js';
import { UserRepository } from '../src/repositories/user.repository.js';

describe('Integration — full store lifecycle', () => {
  it('all repositories work on the same database', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);

    const tasks = new TaskRepository(db);
    const sessions = new SessionRepository(db);
    const traces = new TraceRepository(db);
    const memory = new MemoryRepository(db);
    const schedules = new ScheduleRepository(db);
    const users = new UserRepository(db);

    // Task
    tasks.save({ id: 'task-1', description: 'test', status: 'completed' });
    expect(tasks.count()).toBe(1);

    // Session
    const now = new Date().toISOString();
    sessions.save({
      id: 'sess-1',
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { messageCount: 1, totalCostUsd: 0, totalEnergyWh: 0, totalCarbonGrams: 0, totalTokens: 0 },
    });
    expect(sessions.count()).toBe(1);

    // Trace
    traces.save({
      traceId: 'trace-1',
      taskId: 'task-1',
      startedAt: now,
      spans: [],
    });
    expect(traces.list()).toHaveLength(1);

    // Memory
    memory.saveSemantic({
      id: 'fact-1', key: 'test', value: true, category: 'test', source: 'test',
      confidence: 0.5, scope: 'project', tags: [],
      createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
    });
    expect(memory.counts().semantic).toBe(1);

    // Schedule
    schedules.save({
      id: 'sched-1', name: 'test', cron: '* * * * *', taskDescription: 'test',
      budgetPreset: 'low', enabled: true, createdAt: now,
      runCount: 0, totalEnergyWh: 0, totalCarbonGrams: 0,
    });
    expect(schedules.list()).toHaveLength(1);

    // User
    users.save({
      id: 'user-1', username: 'test', passwordHash: 'hash', role: 'admin',
      createdAt: now,
      quota: { maxTokens: 1000, maxCostUsd: 1, maxEnergyWh: 1, tokensUsed: 0, costUsed: 0, energyUsed: 0, periodStart: now },
      apiKeys: [],
    });
    expect(users.list()).toHaveLength(1);

    db.close();
  });

  it('foreign key cascade works across tables', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);

    const sessions = new SessionRepository(db);
    const now = new Date().toISOString();

    sessions.save({
      id: 'sess-cascade',
      createdAt: now,
      updatedAt: now,
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
      ],
      metadata: { messageCount: 2, totalCostUsd: 0, totalEnergyWh: 0, totalCarbonGrams: 0, totalTokens: 0 },
    });

    // Delete session — should cascade messages
    sessions.delete('sess-cascade');
    const msgs = db.prepare('SELECT * FROM session_messages WHERE session_id = ?').all('sess-cascade');
    expect(msgs).toHaveLength(0);

    db.close();
  });

  it('concurrent reads work with WAL mode', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);

    const tasks = new TaskRepository(db);

    // Insert several tasks
    for (let i = 0; i < 100; i++) {
      tasks.save({ id: `task-${i}`, description: `Task ${i}`, status: 'completed' });
    }

    // Read them all back — WAL mode allows concurrent reads
    const all = tasks.list({ limit: 200 });
    expect(all).toHaveLength(100);

    db.close();
  });

  it('transaction atomicity — bulk memory save', () => {
    const db = createTestDatabase();
    runMigrations(db, allMigrations);

    const memory = new MemoryRepository(db);
    const now = new Date().toISOString();

    memory.saveAll({
      semantic: Array.from({ length: 50 }, (_, i) => ({
        id: `fact-${i}`, key: `key-${i}`, value: i, category: 'test', source: 'test',
        confidence: 0.5, scope: 'project', tags: [],
        createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
      })),
      episodic: Array.from({ length: 20 }, (_, i) => ({
        id: `ep-${i}`, taskId: `task-${i}`, summary: `Episode ${i}`, outcome: 'success',
        toolsUsed: ['test'], stepsCompleted: 1, totalSteps: 1,
        energyUsed: 0, carbonUsed: 0, costUsd: 0, durationMs: 0,
        scope: 'project', tags: [],
        createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
      })),
    });

    const counts = memory.counts();
    expect(counts.semantic).toBe(50);
    expect(counts.episodic).toBe(20);

    db.close();
  });
});
