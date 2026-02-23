import { Hono } from 'hono';
import type { UserStore } from '../auth/user-store.js';
import { signJwt } from '../auth/jwt.js';
import type { AuthConfig } from '@joule/shared';
import { loginRequestSchema, registerRequestSchema } from '@joule/shared';

export function authRoutes(userStore: UserStore, authConfig: AuthConfig) {
  const router = new Hono();

  // Login
  router.post('/login', async (c) => {
    const body = await c.req.json();
    const parsed = loginRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
    }

    const user = userStore.getByUsername(parsed.data.username);
    if (!user || !UserStore.verifyPassword(parsed.data.password, user.passwordHash)) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = signJwt(
      { sub: user.id, username: user.username, role: user.role },
      authConfig.jwtSecret,
      authConfig.tokenExpirySeconds,
    );

    return c.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
      },
    });
  });

  // Register
  router.post('/register', async (c) => {
    const body = await c.req.json();
    const parsed = registerRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({ error: 'Invalid request', issues: parsed.error.issues }, 400);
    }

    try {
      const user = await userStore.createUser(
        parsed.data.username,
        parsed.data.password,
        parsed.data.role,
      );

      const token = signJwt(
        { sub: user.id, username: user.username, role: user.role },
        authConfig.jwtSecret,
        authConfig.tokenExpirySeconds,
      );

      return c.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Registration failed' }, 409);
    }
  });

  // Get current user (requires auth - applied by middleware)
  router.get('/me', (c) => {
    const userId = c.get('userId');
    const user = userStore.getById(userId);
    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    return c.json({
      id: user.id,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
      apiKeys: user.apiKeys.map(k => ({
        id: k.id,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
        keyPrefix: k.key.slice(0, 8) + '...',
      })),
      quota: user.quota,
    });
  });

  // Create API key (requires auth)
  router.post('/api-keys', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json().catch(() => ({}));
    const name = body.name || 'default';

    const apiKey = await userStore.createApiKey(userId, name);
    return c.json({
      id: apiKey.id,
      key: apiKey.key, // Only shown once at creation
      name: apiKey.name,
      createdAt: apiKey.createdAt,
    }, 201);
  });

  // Delete API key (requires auth)
  router.delete('/api-keys/:id', async (c) => {
    const userId = c.get('userId');
    const keyId = c.req.param('id');

    const deleted = await userStore.deleteApiKey(userId, keyId);
    if (!deleted) {
      return c.json({ error: 'API key not found' }, 404);
    }
    return c.json({ deleted: true });
  });

  return router;
}
