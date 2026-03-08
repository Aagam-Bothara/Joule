import { Hono } from 'hono';
import type { Joule } from '@joule/core';
import { replayTask } from '@joule/core';

export function replayRoutes(joule: Joule) {
  const router = new Hono();

  // POST /replay/:id — replay a task with overrides
  router.post('/:id', async (c) => {
    const taskId = c.req.param('id');

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // No body is fine — replay with defaults
    }

    try {
      const result = await replayTask(joule, {
        originalTaskId: taskId,
        overrides: {
          budget: body.budget as string | undefined,
          governance: body.governance as boolean | undefined,
        },
      });

      return c.json(result);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  return router;
}
