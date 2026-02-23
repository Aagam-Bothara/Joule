import type { Context, Next } from 'hono';
import { verifyJwt } from './jwt.js';
import type { UserStore } from './user-store.js';
import type { AuthConfig, AuthTokenPayload } from '@joule/shared';

declare module 'hono' {
  interface ContextVariableMap {
    userId: string;
    username: string;
    userRole: string;
  }
}

export function authMiddleware(userStore: UserStore, authConfig: AuthConfig) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Try JWT (Bearer token)
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      // Check if it's an API key (starts with jk_)
      if (token.startsWith('jk_')) {
        const user = userStore.getByApiKey(token);
        if (!user) {
          return c.json({ error: 'Invalid API key' }, 401);
        }

        // Check quota
        const quota = userStore.checkQuota(user.id);
        if (!quota.allowed) {
          return c.json({ error: `Quota exceeded: ${quota.reason}` }, 429);
        }

        // Update last used timestamp (fire-and-forget)
        userStore.updateApiKeyLastUsed(token);

        c.set('userId', user.id);
        c.set('username', user.username);
        c.set('userRole', user.role);
        return next();
      }

      // Try JWT
      const payload = verifyJwt(token, authConfig.jwtSecret);
      if (!payload) {
        return c.json({ error: 'Invalid or expired token' }, 401);
      }

      // Verify user still exists
      const user = userStore.getById(payload.sub);
      if (!user) {
        return c.json({ error: 'User not found' }, 401);
      }

      // Check quota
      const quota = userStore.checkQuota(user.id);
      if (!quota.allowed) {
        return c.json({ error: `Quota exceeded: ${quota.reason}` }, 429);
      }

      c.set('userId', user.id);
      c.set('username', user.username);
      c.set('userRole', user.role);
      return next();
    }

    return c.json({ error: 'Invalid authorization format' }, 401);
  };
}

export function adminMiddleware() {
  return async (c: Context, next: Next) => {
    if (c.get('userRole') !== 'admin') {
      return c.json({ error: 'Admin access required' }, 403);
    }
    return next();
  };
}

// Simple in-memory rate limiter
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(maxRequests: number = 60, windowMs: number = 60_000) {
  return async (c: Context, next: Next) => {
    const key = c.get('userId') || c.req.header('x-forwarded-for') || 'anonymous';
    const now = Date.now();

    let entry = rateLimitMap.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitMap.set(key, entry);
    }

    entry.count++;

    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    return next();
  };
}
