import type Database from 'better-sqlite3';

export interface TaskRow {
  id: string;
  description: string;
  status: string;
  result: string | null;
  step_results: string | null;
  budget_allocated: string | null;
  budget_used: string | null;
  error: string | null;
  trace_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface TaskListOptions {
  status?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'completed_at';
  order?: 'asc' | 'desc';
}

export class TaskRepository {
  private insertStmt: Database.Statement;
  private getByIdStmt: Database.Statement;
  private updateStatusStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private countAllStmt: Database.Statement;
  private countByStatusStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO tasks
        (id, description, status, result, step_results, budget_allocated, budget_used, error, trace_id, created_at, completed_at)
      VALUES
        (@id, @description, @status, @result, @step_results, @budget_allocated, @budget_used, @error, @trace_id, @created_at, @completed_at)
    `);

    this.getByIdStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.updateStatusStmt = db.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?');
    this.deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS c FROM tasks');
    this.countByStatusStmt = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE status = ?');
  }

  save(task: {
    id: string;
    description: string;
    status: string;
    result?: unknown;
    stepResults?: unknown[];
    budgetAllocated?: unknown;
    budgetUsed?: unknown;
    error?: string;
    traceId?: string;
    createdAt?: string;
    completedAt?: string;
  }): void {
    this.insertStmt.run({
      id: task.id,
      description: task.description,
      status: task.status,
      result: task.result != null ? JSON.stringify(task.result) : null,
      step_results: task.stepResults != null ? JSON.stringify(task.stepResults) : null,
      budget_allocated: task.budgetAllocated != null ? JSON.stringify(task.budgetAllocated) : null,
      budget_used: task.budgetUsed != null ? JSON.stringify(task.budgetUsed) : null,
      error: task.error ?? null,
      trace_id: task.traceId ?? null,
      created_at: task.createdAt ?? new Date().toISOString(),
      completed_at: task.completedAt ?? null,
    });
  }

  getById(id: string): TaskRow | null {
    const row = this.getByIdStmt.get(id) as TaskRow | undefined;
    return row ?? null;
  }

  /** Returns deserialized task with parsed JSON fields */
  getByIdParsed(id: string): Record<string, unknown> | null {
    const row = this.getById(id);
    if (!row) return null;
    return this.parseRow(row);
  }

  list(options?: TaskListOptions): TaskRow[] {
    const orderBy = options?.orderBy ?? 'created_at';
    const order = options?.order ?? 'desc';
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    let sql = 'SELECT * FROM tasks';
    const params: unknown[] = [];

    if (options?.status) {
      sql += ' WHERE status = ?';
      params.push(options.status);
    }

    sql += ` ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as TaskRow[];
  }

  updateStatus(id: string, status: string, completedAt?: string): void {
    this.updateStatusStmt.run(status, completedAt ?? null, id);
  }

  delete(id: string): boolean {
    const result = this.deleteStmt.run(id);
    return result.changes > 0;
  }

  count(status?: string): number {
    if (status) {
      return (this.countByStatusStmt.get(status) as { c: number }).c;
    }
    return (this.countAllStmt.get() as { c: number }).c;
  }

  private parseRow(row: TaskRow): Record<string, unknown> {
    return {
      id: row.id,
      description: row.description,
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      stepResults: row.step_results ? JSON.parse(row.step_results) : null,
      budgetAllocated: row.budget_allocated ? JSON.parse(row.budget_allocated) : null,
      budgetUsed: row.budget_used ? JSON.parse(row.budget_used) : null,
      error: row.error,
      traceId: row.trace_id,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }
}
