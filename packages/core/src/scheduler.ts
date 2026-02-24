import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ScheduledTask,
  type ScheduleRunLog,
  type BudgetPresetName,
  generateId,
  isoNow,
} from '@joule/shared';
import type { Joule } from './engine.js';
import type { ScheduleRepository } from '@joule/store';

const DEFAULT_SCHEDULE_FILE = '.joule/schedules.json';
const DEFAULT_LOG_FILE = '.joule/schedule-logs.json';
const TICK_INTERVAL_MS = 60_000; // 1 minute

// --- Cron parsing utilities ---

interface CronField {
  type: 'wildcard' | 'values';
  values: number[];
}

function parseCronField(field: string, min: number, max: number): CronField {
  if (field === '*') {
    return { type: 'wildcard', values: [] };
  }

  const values: number[] = [];

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      // Step: */5 or 1-30/5
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);

      let start = min;
      let end = max;
      if (range !== '*') {
        if (range.includes('-')) {
          const [s, e] = range.split('-').map(Number);
          start = s;
          end = e;
        } else {
          start = parseInt(range, 10);
        }
      }
      for (let i = start; i <= end; i += step) {
        values.push(i);
      }
    } else if (part.includes('-')) {
      // Range: 1-5
      const [start, end] = part.split('-').map(Number);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${part}`);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
    } else {
      // Single value
      const val = parseInt(part, 10);
      if (isNaN(val)) throw new Error(`Invalid value: ${part}`);
      values.push(val);
    }
  }

  // Validate all values in range
  for (const v of values) {
    if (v < min || v > max) {
      throw new Error(`Value ${v} out of range [${min}-${max}]`);
    }
  }

  return { type: 'values', values };
}

export function parseCron(expr: string): CronField[] {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return [
    parseCronField(parts[0], 0, 59),  // minute
    parseCronField(parts[1], 0, 23),  // hour
    parseCronField(parts[2], 1, 31),  // day of month
    parseCronField(parts[3], 1, 12),  // month
    parseCronField(parts[4], 0, 6),   // day of week (0=Sunday)
  ];
}

export function matchesCron(expr: string, date: Date): boolean {
  const fields = parseCron(expr);
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.type === 'wildcard') continue;
    if (!field.values.includes(values[i])) return false;
  }

  return true;
}

export function validateCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

// --- Scheduler class ---

export class Scheduler {
  private schedules: ScheduledTask[] = [];
  private logs: ScheduleRunLog[] = [];
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private runningTasks = new Set<string>();
  private maxConcurrent: number;
  private scheduleFile: string;
  private logFile: string;
  private loaded = false;
  private repo?: ScheduleRepository;

  constructor(
    private joule: Joule,
    options?: { scheduleFile?: string; logFile?: string; maxConcurrent?: number; scheduleRepo?: ScheduleRepository },
  ) {
    this.scheduleFile = options?.scheduleFile
      ? path.resolve(options.scheduleFile)
      : path.join(process.cwd(), DEFAULT_SCHEDULE_FILE);
    this.logFile = options?.logFile
      ? path.resolve(options.logFile)
      : path.join(process.cwd(), DEFAULT_LOG_FILE);
    this.maxConcurrent = options?.maxConcurrent ?? 3;
    this.repo = options?.scheduleRepo;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    if (this.repo) {
      // Load from SQLite
      const schedRows = this.repo.list();
      this.schedules = schedRows.map(r => ({
        id: r.id,
        name: r.name,
        cron: r.cron,
        taskDescription: r.taskDescription,
        budgetPreset: r.budgetPreset as BudgetPresetName,
        enabled: r.enabled,
        createdAt: r.createdAt,
        lastRunAt: r.lastRunAt,
        lastRunStatus: r.lastRunStatus as ScheduledTask['lastRunStatus'],
        runCount: r.runCount,
        totalEnergyWh: r.totalEnergyWh,
        totalCarbonGrams: r.totalCarbonGrams,
      }));
      this.loaded = true;
      return;
    }

    await fs.mkdir(path.dirname(this.scheduleFile), { recursive: true });
    this.schedules = await this.readJson<ScheduledTask[]>(this.scheduleFile, []);
    this.logs = await this.readJson<ScheduleRunLog[]>(this.logFile, []);
    this.loaded = true;
  }

  private async readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return fallback;
    }
  }

  private async saveSchedules(): Promise<void> {
    if (this.repo) {
      for (const s of this.schedules) {
        this.repo.save({
          id: s.id,
          name: s.name,
          cron: s.cron,
          taskDescription: s.taskDescription,
          budgetPreset: s.budgetPreset,
          enabled: s.enabled,
          createdAt: s.createdAt,
          lastRunAt: s.lastRunAt,
          lastRunStatus: s.lastRunStatus,
          runCount: s.runCount,
          totalEnergyWh: s.totalEnergyWh,
          totalCarbonGrams: s.totalCarbonGrams,
        });
      }
      return;
    }

    await fs.mkdir(path.dirname(this.scheduleFile), { recursive: true });
    await fs.writeFile(this.scheduleFile, JSON.stringify(this.schedules, null, 2));
  }

  private async saveLogs(): Promise<void> {
    // When using the repo, logs are saved individually in executeScheduled
    if (this.repo) return;

    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
    await fs.writeFile(this.logFile, JSON.stringify(this.logs, null, 2));
  }

  async add(
    name: string,
    cron: string,
    taskDescription: string,
    budgetPreset: BudgetPresetName = 'medium',
  ): Promise<ScheduledTask> {
    await this.ensureLoaded();

    if (!validateCron(cron)) {
      throw new Error(`Invalid cron expression: ${cron}`);
    }

    const task: ScheduledTask = {
      id: generateId('sched'),
      name,
      cron,
      taskDescription,
      budgetPreset,
      enabled: true,
      createdAt: isoNow(),
      runCount: 0,
      totalEnergyWh: 0,
      totalCarbonGrams: 0,
    };

    this.schedules.push(task);
    await this.saveSchedules();
    return task;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const index = this.schedules.findIndex(s => s.id === id);
    if (index === -1) return false;

    this.schedules.splice(index, 1);
    this.runningTasks.delete(id);
    await this.saveSchedules();
    return true;
  }

  async list(): Promise<ScheduledTask[]> {
    await this.ensureLoaded();
    return [...this.schedules];
  }

  async pause(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const schedule = this.schedules.find(s => s.id === id);
    if (!schedule) return false;

    schedule.enabled = false;
    await this.saveSchedules();
    return true;
  }

  async resume(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const schedule = this.schedules.find(s => s.id === id);
    if (!schedule) return false;

    schedule.enabled = true;
    await this.saveSchedules();
    return true;
  }

  async getLogs(limit?: number): Promise<ScheduleRunLog[]> {
    await this.ensureLoaded();
    const sorted = [...this.logs].sort(
      (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
    );
    return limit ? sorted.slice(0, limit) : sorted;
  }

  start(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    // Run immediately on start
    this.tick();
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.runningTasks.clear();
  }

  private async tick(): Promise<void> {
    try {
      await this.ensureLoaded();
    } catch {
      return;
    }

    const now = new Date();

    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue;
      if (this.runningTasks.has(schedule.id)) continue;
      if (this.runningTasks.size >= this.maxConcurrent) break;

      if (matchesCron(schedule.cron, now)) {
        this.runningTasks.add(schedule.id);
        this.executeScheduled(schedule).finally(() => {
          this.runningTasks.delete(schedule.id);
        });
      }
    }
  }

  private async executeScheduled(schedule: ScheduledTask): Promise<void> {
    const startedAt = isoNow();
    const taskId = generateId('task');

    try {
      const task = {
        id: taskId,
        description: schedule.taskDescription,
        budget: schedule.budgetPreset,
        messages: [],
        createdAt: startedAt,
      };

      const result = await this.joule.execute(task);

      const energyWh = result.budgetUsed.energyWh ?? 0;
      const carbonGrams = result.budgetUsed.carbonGrams ?? 0;

      // Update schedule stats
      schedule.lastRunAt = isoNow();
      schedule.lastRunStatus = result.status === 'completed' ? 'completed'
        : result.status === 'budget_exhausted' ? 'budget_exhausted'
        : 'failed';
      schedule.runCount++;
      schedule.totalEnergyWh += energyWh;
      schedule.totalCarbonGrams += carbonGrams;
      await this.saveSchedules();

      // Log run
      const log: ScheduleRunLog = {
        scheduleId: schedule.id,
        taskId,
        startedAt,
        completedAt: isoNow(),
        status: schedule.lastRunStatus,
        energyWh,
        carbonGrams,
        tokensUsed: result.budgetUsed.tokensUsed,
      };
      this.logs.push(log);
      if (this.repo) {
        this.repo.addLog({
          scheduleId: log.scheduleId,
          taskId: log.taskId,
          startedAt: log.startedAt,
          completedAt: log.completedAt,
          status: log.status,
          energyWh: log.energyWh,
          carbonGrams: log.carbonGrams,
          tokensUsed: log.tokensUsed,
        });
      }
      await this.saveLogs();
    } catch (err) {
      schedule.lastRunAt = isoNow();
      schedule.lastRunStatus = 'failed';
      schedule.runCount++;
      await this.saveSchedules();

      const log: ScheduleRunLog = {
        scheduleId: schedule.id,
        taskId,
        startedAt,
        completedAt: isoNow(),
        status: 'failed',
        energyWh: 0,
        carbonGrams: 0,
        tokensUsed: 0,
      };
      this.logs.push(log);
      if (this.repo) {
        this.repo.addLog({
          scheduleId: log.scheduleId,
          taskId: log.taskId,
          startedAt: log.startedAt,
          completedAt: log.completedAt,
          status: log.status,
          energyWh: log.energyWh,
          carbonGrams: log.carbonGrams,
          tokensUsed: log.tokensUsed,
        });
      }
      await this.saveLogs();
    }
  }
}
