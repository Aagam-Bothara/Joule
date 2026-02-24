import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRepository } from '../src/repositories/session.repository.js';
import { freshDb } from './helpers.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: SessionRepository;

beforeEach(() => {
  db = freshDb();
  repo = new SessionRepository(db);
});

const now = '2024-01-01T00:00:00Z';

function sampleSession(id = 'sess-001') {
  return {
    id,
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: 'user', content: 'Hello', timestamp: now },
      { role: 'assistant', content: 'Hi there!', timestamp: now },
    ],
    metadata: {
      messageCount: 2,
      totalCostUsd: 0.01,
      totalEnergyWh: 0.005,
      totalCarbonGrams: 0.002,
      totalTokens: 150,
    },
  };
}

describe('SessionRepository', () => {
  it('saves and loads a session with messages', () => {
    const session = sampleSession();
    repo.save(session);

    const loaded = repo.load('sess-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('sess-001');
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].role).toBe('user');
    expect(loaded!.messages[0].content).toBe('Hello');
    expect(loaded!.messages[1].role).toBe('assistant');
    expect(loaded!.metadata.messageCount).toBe(2);
    expect(loaded!.metadata.totalCostUsd).toBe(0.01);
    expect(loaded!.metadata.totalTokens).toBe(150);
  });

  it('returns null for non-existent session', () => {
    expect(repo.load('nonexistent')).toBeNull();
  });

  it('upserts on save — replaces messages', () => {
    repo.save(sampleSession());
    repo.save({
      ...sampleSession(),
      messages: [{ role: 'user', content: 'New message', timestamp: now }],
      metadata: { ...sampleSession().metadata, messageCount: 1 },
    });

    const loaded = repo.load('sess-001');
    expect(loaded!.messages).toHaveLength(1);
    expect(loaded!.messages[0].content).toBe('New message');
  });

  it('lists sessions ordered by updated_at DESC', () => {
    repo.save({ ...sampleSession('sess-001'), updatedAt: '2024-01-01T00:00:00Z' });
    repo.save({ ...sampleSession('sess-002'), updatedAt: '2024-01-02T00:00:00Z' });

    const list = repo.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('sess-002');
    expect(list[0].preview).toBe('Hello');
  });

  it('adds a message to existing session', () => {
    repo.save(sampleSession());
    repo.addMessage('sess-001', { role: 'user', content: 'Follow-up', timestamp: now });

    const loaded = repo.load('sess-001');
    expect(loaded!.messages).toHaveLength(3);
    expect(loaded!.messages[2].content).toBe('Follow-up');
  });

  it('updates session metadata', () => {
    repo.save(sampleSession());
    repo.updateMetadata('sess-001', { totalTokens: 300, totalCostUsd: 0.05 });

    const loaded = repo.load('sess-001');
    expect(loaded!.metadata.totalTokens).toBe(300);
    expect(loaded!.metadata.totalCostUsd).toBe(0.05);
    // Other fields remain unchanged
    expect(loaded!.metadata.totalEnergyWh).toBe(0.005);
  });

  it('deletes a session and cascades messages', () => {
    repo.save(sampleSession());
    expect(repo.delete('sess-001')).toBe(true);
    expect(repo.load('sess-001')).toBeNull();

    // Messages should be cascaded
    const msgs = db.prepare('SELECT * FROM session_messages WHERE session_id = ?').all('sess-001');
    expect(msgs).toHaveLength(0);
  });

  it('counts sessions', () => {
    expect(repo.count()).toBe(0);
    repo.save(sampleSession('sess-001'));
    repo.save(sampleSession('sess-002'));
    expect(repo.count()).toBe(2);
  });
});
