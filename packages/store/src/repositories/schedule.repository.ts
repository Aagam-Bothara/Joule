import type Database from 'better-sqlite3';

// ── Row types ────────────────────────────────────────────────────

export interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  task_description: string;
  budget_preset: string;
  enabled: number;          // SQLite boolean: 0 | 1
  created_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  run_count: number;
  total_energy_wh: number;
  total_carbon_grams: number;
}

export interface ScheduleLogRow {
  id: number;
  schedule_id: string;
  task_id: string;
  started_at: string;
  completed_at: string;
  status: string;
  energy_wh: number;
  carbon_grams: number;
  tokens_used: number;
}

// ── Data types (camelCase API) ──────────────────────────────────

export interface ScheduleData {
  id: string;
  name: string;
  cron: string;
  taskDescription: string;
  budgetPreset: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  runCount: number;
  totalEnergyWh: number;
  totalCarbonGrams: number;
}

export interface ScheduleLogData {
  id?: number;
  scheduleId: string;
  taskId: string;
  startedAt: string;
  completedAt: string;
  status: string;
  energyWh: number;
  carbonGrams: number;
  tokensUsed: number;
}

export interface ScheduleLogOptions {
  scheduleId?: string;
  limit?: number;
  offset?: number;
}

// ── Repository ──────────────────────────────────────────────────

export class ScheduleRepository {
  private insertStmt: Database.Statement;
  private getByIdStmt: Database.Statement;
  private listAllStmt: Database.Statement;
  private listEnabledStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private insertLogStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO schedules
        (id, name, cron, task_description, budget_preset, enabled, created_at,
         last_run_at, last_run_status, run_count, total_energy_wh, total_carbon_grams)
      VALUES
        (@id, @name, @cron, @task_description, @budget_preset, @enabled, @created_at,
         @last_run_at, @last_run_status, @run_count, @total_energy_wh, @total_carbon_grams)
    `);

    this.getByIdStmt = db.prepare('SELECT * FROM schedules WHERE id = ?');
    this.listAllStmt = db.prepare('SELECT * FROM schedules ORDER BY created_at DESC');
    this.listEnabledStmt = db.prepare('SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at DESC');

    this.updateStmt = db.prepare(`
      UPDATE schedules SET
        name = @name,
        cron = @cron,
        task_description = @task_description,
        budget_preset = @budget_preset,
        enabled = @enabled,
        last_run_at = @last_run_at,
        last_run_status = @last_run_status,
        run_count = @run_count,
        total_energy_wh = @total_energy_wh,
        total_carbon_grams = @total_carbon_grams
      WHERE id = @id
    `);

    this.deleteStmt = db.prepare('DELETE FROM schedules WHERE id = ?');

    this.insertLogStmt = db.prepare(`
      INSERT INTO schedule_logs
        (schedule_id, task_id, started_at, completed_at, status, energy_wh, carbon_grams, tokens_used)
      VALUES
        (@schedule_id, @task_id, @started_at, @completed_at, @status, @energy_wh, @carbon_grams, @tokens_used)
    `);
  }

  save(schedule: ScheduleData): void {
    this.insertStmt.run({
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      task_description: schedule.taskDescription,
      budget_preset: schedule.budgetPreset,
      enabled: schedule.enabled ? 1 : 0,
      created_at: schedule.createdAt,
      last_run_at: schedule.lastRunAt ?? null,
      last_run_status: schedule.lastRunStatus ?? null,
      run_count: schedule.runCount,
      total_energy_wh: schedule.totalEnergyWh,
      total_carbon_grams: schedule.totalCarbonGrams,
    });
  }

  getById(id: string): ScheduleData | null {
    const row = this.getByIdStmt.get(id) as ScheduleRow | undefined;
    if (!row) return null;
    return this.parseRow(row);
  }

  list(): ScheduleData[] {
    const rows = this.listAllStmt.all() as ScheduleRow[];
    return rows.map(r => this.parseRow(r));
  }

  listEnabled(): ScheduleData[] {
    const rows = this.listEnabledStmt.all() as ScheduleRow[];
    return rows.map(r => this.parseRow(r));
  }

  update(schedule: ScheduleData): boolean {
    const result = this.updateStmt.run({
      id: schedule.id,
      name: schedule.name,
      cron: schedule.cron,
      task_description: schedule.taskDescription,
      budget_preset: schedule.budgetPreset,
      enabled: schedule.enabled ? 1 : 0,
      last_run_at: schedule.lastRunAt ?? null,
      last_run_status: schedule.lastRunStatus ?? null,
      run_count: schedule.runCount,
      total_energy_wh: schedule.totalEnergyWh,
      total_carbon_grams: schedule.totalCarbonGrams,
    });
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  addLog(log: ScheduleLogData): void {
    this.insertLogStmt.run({
      schedule_id: log.scheduleId,
      task_id: log.taskId,
      started_at: log.startedAt,
      completed_at: log.completedAt,
      status: log.status,
      energy_wh: log.energyWh,
      carbon_grams: log.carbonGrams,
      tokens_used: log.tokensUsed,
    });
  }

  getLogs(options?: ScheduleLogOptions): ScheduleLogData[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.scheduleId) {
      conditions.push('schedule_id = ?');
      params.push(options.scheduleId);
    }

    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    params.push(limit, offset);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM schedule_logs ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as ScheduleLogRow[];

    return rows.map(r => ({
      id: r.id,
      scheduleId: r.schedule_id,
      taskId: r.task_id,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      status: r.status,
      energyWh: r.energy_wh,
      carbonGrams: r.carbon_grams,
      tokensUsed: r.tokens_used,
    }));
  }

  private parseRow(row: ScheduleRow): ScheduleData {
    return {
      id: row.id,
      name: row.name,
      cron: row.cron,
      taskDescription: row.task_description,
      budgetPreset: row.budget_preset,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastRunAt: row.last_run_at ?? undefined,
      lastRunStatus: row.last_run_status ?? undefined,
      runCount: row.run_count,
      totalEnergyWh: row.total_energy_wh,
      totalCarbonGrams: row.total_carbon_grams,
    };
  }
}
