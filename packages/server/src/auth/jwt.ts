import { createHmac } from 'node:crypto';
import type { AuthTokenPayload } from '@joule/shared';

function base64url(data: string): string {
  return Buffer.from(data).toString('base64url');
}

function base64urlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

export function signJwt(payload: AuthTokenPayload, secret: string, expirySeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64url(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + expirySeconds,
  }));

  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string, secret: string): AuthTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;

  // Verify signature
  const expected = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  if (signature !== expected) return null;

  // Parse and check expiry
  try {
    const payload = JSON.parse(base64urlDecode(body));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) return null;

    return {
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
    };
  } catch {
    return null;
  }
}
