import { Hono } from 'hono';
import type { UserStore } from '../auth/user-store.js';

export function usersRoutes(userStore: UserStore) {
  const router = new Hono();

  // List all users (admin only)
  router.get('/', (c) => {
    const users = userStore.listUsers().map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      apiKeyCount: u.apiKeys.length,
      quota: {
        tokensUsed: u.quota.tokensUsed,
        maxTokens: u.quota.maxTokens,
        costUsed: u.quota.costUsed,
        maxCostUsd: u.quota.maxCostUsd,
        energyUsed: u.quota.energyUsed,
        maxEnergyWh: u.quota.maxEnergyWh,
      },
    }));
    return c.json({ users });
  });

  // Get user details (admin only)
  router.get('/:id', (c) => {
    const user = userStore.getById(c.req.param('id'));
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      apiKeyCount: user.apiKeys.length,
      quota: user.quota,
    });
  });

  // Delete user (admin only)
  router.delete('/:id', async (c) => {
    const targetId = c.req.param('id');
    const currentUserId = c.get('userId');

    if (targetId === currentUserId) {
      return c.json({ error: 'Cannot delete your own account' }, 400);
    }

    const deleted = await userStore.deleteUser(targetId);
    if (!deleted) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json({ deleted: true });
  });

  // Get user quota (admin only)
  router.get('/:id/quota', (c) => {
    const user = userStore.getById(c.req.param('id'));
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }
    return c.json(user.quota);
  });

  return router;
}
