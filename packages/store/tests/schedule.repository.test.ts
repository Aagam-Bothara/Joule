import { describe, it, expect, beforeEach } from 'vitest';
import { ScheduleRepository } from '../src/repositories/schedule.repository.js';
import { freshDb } from './helpers.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: ScheduleRepository;

const now = '2024-01-01T00:00:00Z';

beforeEach(() => {
  db = freshDb();
  repo = new ScheduleRepository(db);
});

const sampleSchedule = {
  id: 'sched-001',
  name: 'Daily backup',
  cron: '0 2 * * *',
  taskDescription: 'Backup database',
  budgetPreset: 'low',
  enabled: true,
  createdAt: now,
  lastRunAt: undefined as string | undefined,
  lastRunStatus: undefined as string | undefined,
  runCount: 0,
  totalEnergyWh: 0,
  totalCarbonGrams: 0,
};

describe('ScheduleRepository', () => {
  it('saves and retrieves a schedule', () => {
    repo.save(sampleSchedule);
    const loaded = repo.getById('sched-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('Daily backup');
    expect(loaded!.cron).toBe('0 2 * * *');
    expect(loaded!.enabled).toBe(true);
  });

  it('returns null for non-existent schedule', () => {
    expect(repo.getById('nonexistent')).toBeNull();
  });

  it('lists all schedules', () => {
    repo.save(sampleSchedule);
    repo.save({ ...sampleSchedule, id: 'sched-002', name: 'Weekly report', enabled: false });

    const all = repo.list();
    expect(all).toHaveLength(2);
  });

  it('lists only enabled schedules', () => {
    repo.save(sampleSchedule);
    repo.save({ ...sampleSchedule, id: 'sched-002', name: 'Weekly report', enabled: false });

    const enabled = repo.listEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('sched-001');
  });

  it('updates a schedule', () => {
    repo.save(sampleSchedule);
    const updated = repo.update({
      ...sampleSchedule,
      enabled: false,
      lastRunAt: '2024-01-02T02:00:00Z',
      lastRunStatus: 'completed',
      runCount: 1,
      totalEnergyWh: 0.005,
    });

    expect(updated).toBe(true);
    const loaded = repo.getById('sched-001');
    expect(loaded!.enabled).toBe(false);
    expect(loaded!.runCount).toBe(1);
    expect(loaded!.totalEnergyWh).toBe(0.005);
  });

  it('deletes a schedule', () => {
    repo.save(sampleSchedule);
    expect(repo.delete('sched-001')).toBe(true);
    expect(repo.getById('sched-001')).toBeNull();
  });

  it('adds and retrieves schedule logs', () => {
    repo.save(sampleSchedule);
    repo.addLog({
      scheduleId: 'sched-001',
      taskId: 'task-001',
      startedAt: '2024-01-02T02:00:00Z',
      completedAt: '2024-01-02T02:01:00Z',
      status: 'completed',
      energyWh: 0.005,
      carbonGrams: 0.002,
      tokensUsed: 1500,
    });

    const logs = repo.getLogs({ scheduleId: 'sched-001' });
    expect(logs).toHaveLength(1);
    expect(logs[0].taskId).toBe('task-001');
    expect(logs[0].status).toBe('completed');
    expect(logs[0].tokensUsed).toBe(1500);
  });

  it('getLogs supports pagination', () => {
    repo.save(sampleSchedule);
    for (let i = 0; i < 5; i++) {
      repo.addLog({
        scheduleId: 'sched-001',
        taskId: `task-${i}`,
        startedAt: new Date(Date.now() - i * 86400000).toISOString(),
        completedAt: new Date(Date.now() - i * 86400000 + 60000).toISOString(),
        status: 'completed',
        energyWh: 0.001,
        carbonGrams: 0.001,
        tokensUsed: 100,
      });
    }

    const page = repo.getLogs({ limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });
});
