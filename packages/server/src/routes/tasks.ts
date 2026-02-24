import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  generateId,
  taskSubmissionSchema,
  type Task,
  type TaskResult,
} from '@joule/shared';
import type { Joule } from '@joule/core';
import type { TaskRepository } from '@joule/store';

export function tasksRoutes(joule: Joule, taskRepo?: TaskRepository) {
  const router = new Hono();
  const taskResults = new Map<string, TaskResult>();

  // Helper: persist result to both in-memory map and SQLite
  function storeResult(taskId: string, result: TaskResult) {
    taskResults.set(taskId, result);
    if (taskRepo) {
      try {
        taskRepo.save({
          id: result.id ?? taskId,
          description: result.taskId ?? taskId,
          status: result.status,
          result: result.result,
          stepResults: result.stepResults,
          budgetAllocated: result.budgetAllocated,
          budgetUsed: result.budgetUsed,
          error: result.error,
          traceId: result.trace?.traceId,
          createdAt: result.startedAt,
          completedAt: result.completedAt,
        });
      } catch {
        // DB persistence is best-effort
      }
    }
  }

  // List all tasks
  router.get('/', (c) => {
    if (taskRepo) {
      const rows = taskRepo.list({ limit: 100, order: 'desc' });
      return c.json(rows.map(r => ({
        id: r.id,
        description: r.description,
        status: r.status,
        created_at: r.created_at,
        completed_at: r.completed_at,
      })));
    }

    const results = Array.from(taskResults.values()).map(r => ({
      id: r.id,
      taskId: r.taskId,
      status: r.status,
      completedAt: r.completedAt,
      budgetUsed: r.budgetUsed,
    }));
    return c.json(results);
  });

  // Submit and execute task (blocking)
  router.post('/', async (c) => {
    const body = await c.req.json();
    const parsed = taskSubmissionSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: 'Invalid request', issues: parsed.error.issues },
        400,
      );
    }

    const task: Task = {
      id: generateId('task'),
      description: parsed.data.description,
      budget: parsed.data.budget ?? 'medium',
      context: parsed.data.context,
      tools: parsed.data.tools,
      createdAt: new Date().toISOString(),
    };

    const result = await joule.execute(task);
    storeResult(task.id, result);

    return c.json(result, 201);
  });

  // Submit and stream task via SSE
  router.post('/stream', (c) => {
    const bodyPromise = c.req.json();

    return streamSSE(c, async (stream) => {
      const body = await bodyPromise;
      const parsed = taskSubmissionSchema.safeParse(body);

      if (!parsed.success) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'Invalid request', issues: parsed.error.issues }),
        });
        return;
      }

      const task: Task = {
        id: generateId('task'),
        description: parsed.data.description,
        budget: parsed.data.budget ?? 'medium',
        context: parsed.data.context,
        tools: parsed.data.tools,
        createdAt: new Date().toISOString(),
      };

      for await (const event of joule.executeStream(task)) {
        if (event.type === 'progress') {
          await stream.writeSSE({
            event: 'progress',
            data: JSON.stringify(event.progress),
          });
        } else if (event.type === 'chunk') {
          await stream.writeSSE({
            event: 'chunk',
            data: JSON.stringify(event.chunk),
          });
        } else if (event.type === 'result') {
          storeResult(task.id, event.result!);
          await stream.writeSSE({
            event: 'result',
            data: JSON.stringify(event.result),
          });
        }
      }
    });
  });

  router.get('/:id', (c) => {
    const id = c.req.param('id');

    // Try in-memory first
    let result = taskResults.get(id);

    // Fall back to SQLite
    if (!result && taskRepo) {
      const parsed = taskRepo.getByIdParsed(id);
      if (parsed) {
        return c.json(parsed);
      }
    }

    if (!result) {
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json(result);
  });

  router.get('/:id/trace', (c) => {
    const result = taskResults.get(c.req.param('id'));
    if (!result) {
      return c.json({ error: 'Task not found' }, 404);
    }
    return c.json(result.trace);
  });

  return router;
}
