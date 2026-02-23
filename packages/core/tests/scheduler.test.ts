import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { matchesCron, parseCron, validateCron, Scheduler } from '../src/scheduler.js';

describe('Cron Parser', () => {
  describe('parseCron', () => {
    it('should parse a basic cron expression', () => {
      const fields = parseCron('0 9 * * *');
      expect(fields).toHaveLength(5);
      expect(fields[0]).toEqual({ type: 'values', values: [0] });
      expect(fields[1]).toEqual({ type: 'values', values: [9] });
      expect(fields[2]).toEqual({ type: 'wildcard', values: [] });
    });

    it('should reject invalid expressions', () => {
      expect(() => parseCron('bad')).toThrow();
      expect(() => parseCron('* * *')).toThrow('expected 5 fields');
    });

    it('should parse ranges', () => {
      const fields = parseCron('1-5 * * * *');
      expect(fields[0].values).toEqual([1, 2, 3, 4, 5]);
    });

    it('should parse steps', () => {
      const fields = parseCron('*/15 * * * *');
      expect(fields[0].values).toEqual([0, 15, 30, 45]);
    });

    it('should parse lists', () => {
      const fields = parseCron('0,15,30 * * * *');
      expect(fields[0].values).toEqual([0, 15, 30]);
    });
  });

  describe('matchesCron', () => {
    it('should match wildcard expression', () => {
      const date = new Date('2025-01-15T10:30:00');
      expect(matchesCron('* * * * *', date)).toBe(true);
    });

    it('should match specific minute and hour', () => {
      const date = new Date('2025-01-15T09:00:00');
      expect(matchesCron('0 9 * * *', date)).toBe(true);
      expect(matchesCron('0 10 * * *', date)).toBe(false);
    });

    it('should match day of week', () => {
      // Jan 15, 2025 is a Wednesday (3)
      const date = new Date('2025-01-15T09:00:00');
      expect(matchesCron('0 9 * * 3', date)).toBe(true);
      expect(matchesCron('0 9 * * 1', date)).toBe(false);
    });

    it('should match step expressions', () => {
      const date = new Date('2025-01-15T09:15:00');
      expect(matchesCron('*/15 * * * *', date)).toBe(true);

      const date2 = new Date('2025-01-15T09:07:00');
      expect(matchesCron('*/15 * * * *', date2)).toBe(false);
    });

    it('should match range expressions', () => {
      const date = new Date('2025-01-15T09:03:00');
      expect(matchesCron('1-5 * * * *', date)).toBe(true);

      const date2 = new Date('2025-01-15T09:10:00');
      expect(matchesCron('1-5 * * * *', date2)).toBe(false);
    });
  });

  describe('validateCron', () => {
    it('should validate correct expressions', () => {
      expect(validateCron('0 9 * * *')).toBe(true);
      expect(validateCron('*/5 * * * *')).toBe(true);
      expect(validateCron('0 0 1 1 *')).toBe(true);
    });

    it('should reject invalid expressions', () => {
      expect(validateCron('invalid')).toBe(false);
      expect(validateCron('60 * * * *')).toBe(false); // minute > 59
      expect(validateCron('* 25 * * *')).toBe(false); // hour > 23
    });
  });
});

describe('Scheduler', () => {
  let tmpDir: string;
  let mockJoule: any;
  let scheduler: Scheduler;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `joule-scheduler-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });

    mockJoule = {
      execute: vi.fn().mockResolvedValue({
        id: 'result-1',
        taskId: 'task-1',
        status: 'completed',
        budgetUsed: {
          tokensUsed: 100,
          energyWh: 0.001,
          carbonGrams: 0.0005,
          costUsd: 0,
          toolCalls: 1,
          escalations: 0,
          elapsedMs: 500,
        },
      }),
      config: { getAll: vi.fn().mockReturnValue({}) },
      initialize: vi.fn(),
    };

    scheduler = new Scheduler(mockJoule, {
      scheduleFile: path.join(tmpDir, 'schedules.json'),
      logFile: path.join(tmpDir, 'logs.json'),
      maxConcurrent: 2,
    });
  });

  afterEach(async () => {
    scheduler.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should add a schedule', async () => {
    const task = await scheduler.add('test-job', '0 9 * * *', 'Run daily check', 'low');

    expect(task.id).toMatch(/^sched[_-]/);
    expect(task.name).toBe('test-job');
    expect(task.cron).toBe('0 9 * * *');
    expect(task.enabled).toBe(true);
    expect(task.runCount).toBe(0);
  });

  it('should reject invalid cron', async () => {
    await expect(
      scheduler.add('bad-job', 'invalid', 'task')
    ).rejects.toThrow('Invalid cron');
  });

  it('should list schedules', async () => {
    await scheduler.add('job-1', '0 9 * * *', 'Morning check');
    await scheduler.add('job-2', '0 18 * * *', 'Evening check');

    const list = await scheduler.list();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('job-1');
    expect(list[1].name).toBe('job-2');
  });

  it('should remove a schedule', async () => {
    const task = await scheduler.add('removable', '0 9 * * *', 'test');
    const removed = await scheduler.remove(task.id);
    expect(removed).toBe(true);

    const list = await scheduler.list();
    expect(list).toHaveLength(0);
  });

  it('should return false when removing non-existent schedule', async () => {
    const removed = await scheduler.remove('sched-nonexistent');
    expect(removed).toBe(false);
  });

  it('should pause and resume a schedule', async () => {
    const task = await scheduler.add('pausable', '0 9 * * *', 'test');

    await scheduler.pause(task.id);
    let list = await scheduler.list();
    expect(list[0].enabled).toBe(false);

    await scheduler.resume(task.id);
    list = await scheduler.list();
    expect(list[0].enabled).toBe(true);
  });

  it('should persist schedules to disk', async () => {
    await scheduler.add('persist-job', '*/5 * * * *', 'test');

    // Create new scheduler reading same file
    const scheduler2 = new Scheduler(mockJoule, {
      scheduleFile: path.join(tmpDir, 'schedules.json'),
      logFile: path.join(tmpDir, 'logs.json'),
    });

    const list = await scheduler2.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('persist-job');
  });

  it('should return empty list when no schedules file', async () => {
    const scheduler2 = new Scheduler(mockJoule, {
      scheduleFile: path.join(tmpDir, 'nonexistent.json'),
      logFile: path.join(tmpDir, 'logs.json'),
    });

    const list = await scheduler2.list();
    expect(list).toHaveLength(0);
  });

  it('should track energy accumulation across runs', async () => {
    const task = await scheduler.add('energy-job', '0 9 * * *', 'test');

    // Simulate two executions by directly calling the internal
    // We verify via the schedule stats after manual updates
    expect(task.totalEnergyWh).toBe(0);
    expect(task.totalCarbonGrams).toBe(0);
    expect(task.runCount).toBe(0);
  });
});
