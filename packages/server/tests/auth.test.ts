import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserStore } from '../src/auth/user-store.js';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';

let tempDir: string;
let store: UserStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'joule-auth-test-'));
  store = new UserStore(join(tempDir, 'users.json'));
  await store.load();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('UserStore', () => {
  it('creates a user', async () => {
    const user = await store.createUser('alice', 'password123', 'user');
    expect(user.id).toMatch(/^usr_/);
    expect(user.username).toBe('alice');
    expect(user.role).toBe('user');
    expect(user.passwordHash).not.toBe('password123');
  });

  it('rejects duplicate usernames', async () => {
    await store.createUser('alice', 'password123');
    await expect(store.createUser('alice', 'password456')).rejects.toThrow('already exists');
  });

  it('finds user by username', async () => {
    await store.createUser('bob', 'password123');
    const user = store.getByUsername('bob');
    expect(user).toBeDefined();
    expect(user!.username).toBe('bob');
  });

  it('verifies passwords', () => {
    const hash = UserStore.hashPassword('secret123');
    expect(UserStore.verifyPassword('secret123', hash)).toBe(true);
    expect(UserStore.verifyPassword('wrong', hash)).toBe(false);
  });

  it('deletes a user', async () => {
    const user = await store.createUser('charlie', 'password123');
    expect(await store.deleteUser(user.id)).toBe(true);
    expect(store.getById(user.id)).toBeUndefined();
  });

  it('creates and retrieves API keys', async () => {
    const user = await store.createUser('diana', 'password123');
    const key = await store.createApiKey(user.id, 'test-key');
    expect(key.key).toMatch(/^jk_/);

    const found = store.getByApiKey(key.key);
    expect(found).toBeDefined();
    expect(found!.id).toBe(user.id);
  });

  it('deletes API keys', async () => {
    const user = await store.createUser('eve', 'password123');
    const key = await store.createApiKey(user.id, 'to-delete');
    expect(await store.deleteApiKey(user.id, key.id)).toBe(true);
    expect(store.getByApiKey(key.key)).toBeUndefined();
  });

  it('persists across reloads', async () => {
    await store.createUser('frank', 'password123', 'admin');
    const key = await store.createApiKey(store.getByUsername('frank')!.id, 'persist-key');

    const store2 = new UserStore(join(tempDir, 'users.json'));
    await store2.load();
    expect(store2.getByUsername('frank')).toBeDefined();
    expect(store2.getByUsername('frank')!.role).toBe('admin');
    expect(store2.getByApiKey(key.key)).toBeDefined();
  });

  it('manages quotas', async () => {
    const user = await store.createUser('quotaUser', 'password123');
    expect(store.checkQuota(user.id).allowed).toBe(true);

    await store.deductQuota(user.id, 500_000, 5.0, 0.5);
    expect(store.checkQuota(user.id).allowed).toBe(true);

    // Exceed token quota
    await store.deductQuota(user.id, 600_000, 0, 0);
    const result = store.checkQuota(user.id);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Token');
  });

  it('lists all users', async () => {
    await store.createUser('user1', 'pass1');
    await store.createUser('user2', 'pass2');
    await store.createUser('user3', 'pass3');
    expect(store.listUsers()).toHaveLength(3);
  });
});

describe('JWT', () => {
  const secret = 'test-secret-key-for-signing';

  it('signs and verifies a token', () => {
    const token = signJwt(
      { sub: 'usr_123', username: 'alice', role: 'user' },
      secret,
      3600,
    );

    const payload = verifyJwt(token, secret);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('usr_123');
    expect(payload!.username).toBe('alice');
    expect(payload!.role).toBe('user');
  });

  it('rejects invalid signature', () => {
    const token = signJwt(
      { sub: 'usr_123', username: 'alice', role: 'user' },
      secret,
      3600,
    );

    expect(verifyJwt(token, 'wrong-secret')).toBeNull();
  });

  it('rejects expired tokens', () => {
    const token = signJwt(
      { sub: 'usr_123', username: 'alice', role: 'user' },
      secret,
      -1, // Already expired
    );

    expect(verifyJwt(token, secret)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyJwt('not.a.token', secret)).toBeNull();
    expect(verifyJwt('', secret)).toBeNull();
    expect(verifyJwt('abc', secret)).toBeNull();
  });
});
