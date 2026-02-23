import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionManager } from '../src/session-manager.js';

describe('SessionManager', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-session-test-'));
    manager = new SessionManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a new session with default metadata', async () => {
    const session = await manager.create();

    expect(session.id).toMatch(/^session_/);
    expect(session.messages).toEqual([]);
    expect(session.metadata.messageCount).toBe(0);
    expect(session.metadata.totalCostUsd).toBe(0);
    expect(session.metadata.totalTokens).toBe(0);
  });

  it('saves and loads a session from disk', async () => {
    const session = await manager.create();
    manager.addMessage(session, { role: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' });
    manager.addMessage(session, { role: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01Z' });
    await manager.save(session);

    const loaded = await manager.load(session.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.messages.length).toBe(2);
    expect(loaded!.messages[0].content).toBe('Hello');
    expect(loaded!.messages[1].content).toBe('Hi there!');
    expect(loaded!.metadata.messageCount).toBe(1); // Only user messages count
  });

  it('returns null for non-existent session', async () => {
    const loaded = await manager.load('session_nonexistent');
    expect(loaded).toBeNull();
  });

  it('lists sessions sorted by updatedAt descending', async () => {
    const s1 = await manager.create();
    manager.addMessage(s1, { role: 'user', content: 'First session message', timestamp: '2024-01-01T00:00:00Z' });
    await manager.save(s1);

    // Small delay to ensure different updatedAt
    await new Promise(r => setTimeout(r, 10));

    const s2 = await manager.create();
    manager.addMessage(s2, { role: 'user', content: 'Second session message', timestamp: '2024-01-01T00:01:00Z' });
    await manager.save(s2);

    const list = await manager.list();

    expect(list.length).toBe(2);
    expect(list[0].id).toBe(s2.id); // Most recent first
    expect(list[1].id).toBe(s1.id);
    expect(list[0].preview).toContain('Second session');
  });

  it('deletes a session', async () => {
    const session = await manager.create();
    await manager.save(session);

    const deleted = await manager.delete(session.id);
    expect(deleted).toBe(true);

    const loaded = await manager.load(session.id);
    expect(loaded).toBeNull();
  });

  it('returns false when deleting non-existent session', async () => {
    const deleted = await manager.delete('session_nonexistent');
    expect(deleted).toBe(false);
  });

  it('updates metadata incrementally', async () => {
    const session = await manager.create();

    manager.updateMetadata(session, { totalCostUsd: 0.05, totalTokens: 500 });
    manager.updateMetadata(session, { totalCostUsd: 0.03, totalTokens: 300, totalEnergyWh: 0.01 });

    expect(session.metadata.totalCostUsd).toBe(0.08);
    expect(session.metadata.totalTokens).toBe(800);
    expect(session.metadata.totalEnergyWh).toBe(0.01);
  });

  it('trims history to fit token budget', () => {
    const messages = [
      { role: 'user' as const, content: 'A'.repeat(1000), timestamp: '2024-01-01T00:00:00Z' },
      { role: 'assistant' as const, content: 'B'.repeat(1000), timestamp: '2024-01-01T00:00:01Z' },
      { role: 'user' as const, content: 'C'.repeat(1000), timestamp: '2024-01-01T00:00:02Z' },
      { role: 'assistant' as const, content: 'D'.repeat(1000), timestamp: '2024-01-01T00:00:03Z' },
      { role: 'user' as const, content: 'E'.repeat(1000), timestamp: '2024-01-01T00:00:04Z' },
    ];

    // 4 chars per token, so 500 tokens ≈ 2000 chars → should keep ~2 messages
    const trimmed = manager.trimHistory(messages, 500);

    expect(trimmed.length).toBeLessThanOrEqual(3);
    // Should keep the most recent messages
    expect(trimmed[trimmed.length - 1].content).toBe('E'.repeat(1000));
  });

  it('keeps at least one message when trimming', () => {
    const messages = [
      { role: 'user' as const, content: 'A'.repeat(10000), timestamp: '2024-01-01T00:00:00Z' },
    ];

    // Even with very small budget, keep at least 1 message
    const trimmed = manager.trimHistory(messages, 10);
    expect(trimmed.length).toBe(1);
  });
});
