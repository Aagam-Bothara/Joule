import { Hono } from 'hono';
import type { Joule } from '@joule/core';

export function toolsRoutes(joule: Joule) {
  const router = new Hono();

  router.get('/', (c) => {
    const tools = joule.tools.list().map(t => ({
      name: t.name,
      description: t.description,
      tags: t.tags ?? [],
      requiresConfirmation: t.requiresConfirmation ?? false,
    }));

    return c.json({ tools });
  });

  return router;
}
