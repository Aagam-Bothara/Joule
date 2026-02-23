import { Hono } from 'hono';
import type { Joule } from '@joule/core';

export function healthRoutes(joule: Joule) {
  const router = new Hono();

  router.get('/', (c) => {
    const providers = joule.providers.listAll().map(p => ({
      name: p.name,
      tiers: p.supportedTiers,
    }));

    const tools = joule.tools.listNames();

    return c.json({
      status: 'ok',
      version: '0.5.0',
      providers,
      tools,
      config: {
        defaultBudget: joule.config.get('budgets').default,
        routing: joule.config.get('routing'),
        energy: joule.config.get('energy'),
      },
    });
  });

  router.get('/metrics', (c) => {
    return c.json({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeTasks: 0,
      version: '0.5.0',
    });
  });

  router.get('/channels', (c) => {
    const channelNames = [
      'slack',
      'discord',
      'telegram',
      'whatsapp',
      'signal',
      'teams',
      'email',
      'matrix',
      'irc',
      'twilioSms',
      'webhook',
    ] as const;

    const channelsConfig = joule.config.get('channels') ?? {};

    const channels = channelNames.map((name) => ({
      name,
      configured: !!channelsConfig[name],
      enabled: !!channelsConfig[name]?.enabled,
    }));

    return c.json(channels);
  });

  return router;
}
