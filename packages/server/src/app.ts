import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { tasksRoutes } from './routes/tasks.js';
import { toolsRoutes } from './routes/tools.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { usersRoutes } from './routes/users.js';
import { UserStore } from './auth/user-store.js';
import { authMiddleware, adminMiddleware, rateLimitMiddleware } from './auth/middleware.js';
import type { Joule } from '@joule/core';
import type { AuthConfig } from '@joule/shared';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findDashboardDir(): string | null {
  // Try monorepo sibling
  const monoRepo = resolve(__dirname, '..', '..', 'dashboard', 'dist');
  if (existsSync(monoRepo)) return monoRepo;

  // Try node_modules
  const nodeModules = resolve(__dirname, '..', 'node_modules', '@joule', 'dashboard', 'dist');
  if (existsSync(nodeModules)) return nodeModules;

  return null;
}

export async function createApp(joule: Joule) {
  const app = new Hono();

  // CORS for dashboard dev server
  app.use('*', cors({
    origin: ['http://localhost:5173', 'http://localhost:3927'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // Request logging
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  // Error handling
  app.onError((err, c) => {
    console.error('Server error:', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  // Auth setup
  const authConfig = joule.config.get('auth') as AuthConfig | undefined;
  let userStore: UserStore | null = null;

  if (authConfig?.enabled) {
    userStore = new UserStore(resolve('.joule', 'users.json'));
    await userStore.load();

    // Public auth routes (login/register don't need auth)
    app.route('/auth', authRoutes(userStore, authConfig));

    // Rate limiting on API routes
    app.use('/tasks/*', rateLimitMiddleware());
    app.use('/tools/*', rateLimitMiddleware());

    // Authenticated routes
    app.use('/tasks/*', authMiddleware(userStore, authConfig));
    app.use('/auth/me', authMiddleware(userStore, authConfig));
    app.use('/auth/api-keys', authMiddleware(userStore, authConfig));
    app.use('/auth/api-keys/*', authMiddleware(userStore, authConfig));

    // Admin-only user management
    app.use('/users/*', authMiddleware(userStore, authConfig));
    app.use('/users/*', adminMiddleware());
    app.route('/users', usersRoutes(userStore));
  } else {
    // Legacy simple API key auth (backward compatible)
    const apiKey = joule.config.get('server').apiKey;
    if (apiKey) {
      app.use('/tasks/*', async (c, next) => {
        const key = c.req.header('Authorization')?.replace('Bearer ', '');
        if (key !== apiKey) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        await next();
      });
    }
  }

  // Routes
  app.route('/tasks', tasksRoutes(joule));
  app.route('/tools', toolsRoutes(joule));
  app.route('/health', healthRoutes(joule));

  // Dashboard static files
  const dashboardDir = findDashboardDir();
  if (dashboardDir) {
    app.use('/dashboard/*', serveStatic({ root: dashboardDir, rewriteRequestPath: (path) => path.replace('/dashboard', '') }));
    app.get('/dashboard', (c) => c.redirect('/dashboard/'));
  }

  return app;
}

export async function startServer(joule: Joule): Promise<void> {
  const { port, host } = joule.config.get('server');
  const app = await createApp(joule);
  const authConfig = joule.config.get('auth') as AuthConfig | undefined;

  const dashboardDir = findDashboardDir();

  console.log(`Starting Joule server...`);
  serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`Joule server listening on http://${host}:${port}`);
    console.log('');
    console.log('Endpoints:');
    console.log(`  POST   /tasks          - Submit a task`);
    console.log(`  POST   /tasks/stream   - Submit and stream via SSE`);
    console.log(`  GET    /tasks          - List all tasks`);
    console.log(`  GET    /tasks/:id      - Get task result`);
    console.log(`  GET    /tasks/:id/trace - Get execution trace`);
    console.log(`  GET    /tools          - List available tools`);
    console.log(`  GET    /health         - Health check`);
    if (authConfig?.enabled) {
      console.log(`  POST   /auth/login     - Login`);
      console.log(`  POST   /auth/register  - Register`);
      console.log(`  GET    /auth/me        - Current user`);
      console.log(`  POST   /auth/api-keys  - Create API key`);
      console.log(`  GET    /users          - List users (admin)`);
    }
    if (dashboardDir) {
      console.log(`  GET    /dashboard      - Web Dashboard`);
    }
  });
}
