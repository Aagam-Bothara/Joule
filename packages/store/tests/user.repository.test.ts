import { describe, it, expect, beforeEach } from 'vitest';
import { UserRepository } from '../src/repositories/user.repository.js';
import { freshDb } from './helpers.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: UserRepository;

const now = '2024-01-01T00:00:00Z';

beforeEach(() => {
  db = freshDb();
  repo = new UserRepository(db);
});

function sampleUser(id = 'user-001') {
  return {
    id,
    username: `user_${id}`,
    passwordHash: '$2b$10$abcdefghij',
    role: 'user',
    createdAt: now,
    quota: {
      maxTokens: 100000,
      maxCostUsd: 10,
      maxEnergyWh: 5,
      tokensUsed: 0,
      costUsed: 0,
      energyUsed: 0,
      periodStart: now,
    },
    apiKeys: [
      {
        id: 'key-001',
        key: 'jk_abc123',
        name: 'Default',
        createdAt: now,
        lastUsedAt: undefined as string | undefined,
      },
    ],
  };
}

describe('UserRepository', () => {
  it('saves and retrieves a user by id', () => {
    repo.save(sampleUser());
    const loaded = repo.getById('user-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.username).toBe('user_user-001');
    expect(loaded!.quota.maxTokens).toBe(100000);
    expect(loaded!.apiKeys).toHaveLength(1);
    expect(loaded!.apiKeys[0].key).toBe('jk_abc123');
  });

  it('retrieves user by username', () => {
    repo.save(sampleUser());
    const loaded = repo.getByUsername('user_user-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('user-001');
  });

  it('retrieves user by API key', () => {
    repo.save(sampleUser());
    const loaded = repo.getByApiKey('jk_abc123');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('user-001');
  });

  it('returns null for non-existent user', () => {
    expect(repo.getById('nonexistent')).toBeNull();
    expect(repo.getByUsername('nonexistent')).toBeNull();
    expect(repo.getByApiKey('nonexistent')).toBeNull();
  });

  it('lists all users', () => {
    repo.save(sampleUser('user-001'));
    repo.save(sampleUser('user-002'));

    const all = repo.list();
    expect(all).toHaveLength(2);
  });

  it('deletes a user and cascades API keys', () => {
    repo.save(sampleUser());
    expect(repo.delete('user-001')).toBe(true);
    expect(repo.getById('user-001')).toBeNull();

    // API keys should be cascaded
    const keys = db.prepare('SELECT * FROM api_keys WHERE user_id = ?').all('user-001');
    expect(keys).toHaveLength(0);
  });

  it('saves individual API key', () => {
    repo.save(sampleUser());
    repo.saveApiKey('user-001', {
      id: 'key-002',
      key: 'jk_xyz789',
      name: 'Secondary',
      createdAt: now,
    });

    const loaded = repo.getById('user-001');
    expect(loaded!.apiKeys).toHaveLength(2);
  });

  it('deletes individual API key', () => {
    repo.save(sampleUser());
    expect(repo.deleteApiKey('user-001', 'key-001')).toBe(true);

    const loaded = repo.getById('user-001');
    expect(loaded!.apiKeys).toHaveLength(0);
  });

  it('updates API key last used timestamp', () => {
    repo.save(sampleUser());
    repo.updateApiKeyLastUsed('jk_abc123');

    const loaded = repo.getById('user-001');
    expect(loaded!.apiKeys[0].lastUsedAt).toBeDefined();
  });

  it('deducts quota', () => {
    repo.save(sampleUser());
    repo.deductQuota('user-001', 500, 0.05, 0.01);

    const loaded = repo.getById('user-001');
    expect(loaded!.quota.tokensUsed).toBe(500);
    expect(loaded!.quota.costUsed).toBe(0.05);
    expect(loaded!.quota.energyUsed).toBe(0.01);

    // Deduct again — should accumulate
    repo.deductQuota('user-001', 300, 0.03, 0.005);
    const loaded2 = repo.getById('user-001');
    expect(loaded2!.quota.tokensUsed).toBe(800);
  });

  it('resets quota', () => {
    repo.save(sampleUser());
    repo.deductQuota('user-001', 500, 0.05, 0.01);
    repo.resetQuota('user-001');

    const loaded = repo.getById('user-001');
    expect(loaded!.quota.tokensUsed).toBe(0);
    expect(loaded!.quota.costUsed).toBe(0);
    expect(loaded!.quota.energyUsed).toBe(0);
  });
});
