import { describe, it, expect, vi } from 'vitest';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

// We test BaseChannel logic since SlackChannel.start() requires real @slack/bolt

// Mock Joule and SessionManager
function createMockJoule() {
  return {
    config: { getAll: () => ({}) },
    executeStream: vi.fn(async function* () {
      yield {
        type: 'result',
        result: {
          taskId: 'test-task',
          result: 'Test response',
          budgetUsed: {
            tokensUsed: 100,
            costUsd: 0.001,
            elapsedMs: 500,
            energyWh: 0.0001,
            carbonGrams: 0.00005,
          },
          stepResults: [],
          status: 'completed',
        },
      };
    }),
  };
}

function createMockSessionManager() {
  const sessions = new Map<string, any>();
  return {
    create: vi.fn(async () => {
      const session = {
        id: 'session-1',
        messages: [],
        metadata: { messageCount: 0, totalCostUsd: 0, totalEnergyWh: 0, totalCarbonGrams: 0, totalTokens: 0 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.set(session.id, session);
      return session;
    }),
    load: vi.fn(async (id: string) => sessions.get(id) ?? null),
    save: vi.fn(async () => {}),
    addMessage: vi.fn((session: any, msg: any) => { session.messages.push(msg); }),
    updateMetadata: vi.fn(),
  };
}

// Concrete subclass for testing BaseChannel
class TestChannel extends BaseChannel {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  // Expose protected method for testing
  async testHandleMessage(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('Channel Message Handling', () => {
  it('creates session and returns response', async () => {
    const joule = createMockJoule();
    const sessions = createMockSessionManager();
    const channel = new TestChannel(joule as any, sessions as any);

    const response = await channel.testHandleMessage({
      platform: 'slack',
      channelId: 'C123',
      userId: 'U456',
      username: 'testuser',
      text: 'hello joule',
      threadId: 'T789',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Test response');
    expect(response.threadId).toBe('T789');
    expect(sessions.create).toHaveBeenCalled();
    expect(sessions.addMessage).toHaveBeenCalledTimes(2); // user + assistant
  });

  it('reuses session for same channel+thread', async () => {
    const joule = createMockJoule();
    const sessions = createMockSessionManager();
    const channel = new TestChannel(joule as any, sessions as any);

    const msg = {
      platform: 'slack' as const,
      channelId: 'C123',
      userId: 'U456',
      username: 'testuser',
      text: 'first message',
      threadId: 'T789',
      timestamp: new Date().toISOString(),
    };

    await channel.testHandleMessage(msg);
    await channel.testHandleMessage({ ...msg, text: 'second message' });

    // Session was created once, loaded once
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it('includes energy footer in response', async () => {
    const joule = createMockJoule();
    const sessions = createMockSessionManager();
    const channel = new TestChannel(joule as any, sessions as any);

    const response = await channel.testHandleMessage({
      platform: 'slack',
      channelId: 'C123',
      userId: 'U456',
      username: 'testuser',
      text: 'test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Energy:');
    expect(response.text).toContain('Carbon:');
    expect(response.text).toContain('mWh');
    expect(response.text).toContain('mg CO2');
  });

  it('includes metadata in response', async () => {
    const joule = createMockJoule();
    const sessions = createMockSessionManager();
    const channel = new TestChannel(joule as any, sessions as any);

    const response = await channel.testHandleMessage({
      platform: 'slack',
      channelId: 'C123',
      userId: 'U456',
      username: 'testuser',
      text: 'test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata).toBeDefined();
    expect(response.metadata!.taskId).toBe('test-task');
    expect(response.metadata!.tokensUsed).toBe(100);
  });

  it('handles execution failure gracefully', async () => {
    const joule = createMockJoule();
    // Override to yield no result
    joule.executeStream = vi.fn(async function* () {
      yield { type: 'progress', progress: { phase: 'planning' } };
    }) as any;

    const sessions = createMockSessionManager();
    const channel = new TestChannel(joule as any, sessions as any);

    const response = await channel.testHandleMessage({
      platform: 'slack',
      channelId: 'C123',
      userId: 'U456',
      username: 'testuser',
      text: 'test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });

  it('uses configured budget preset', async () => {
    const joule = createMockJoule();
    const sessions = createMockSessionManager();
    const channel = new TestChannel(joule as any, sessions as any, 'high' as any);

    await channel.testHandleMessage({
      platform: 'slack',
      channelId: 'C123',
      userId: 'U456',
      username: 'testuser',
      text: 'test',
      timestamp: new Date().toISOString(),
    });

    // Check that executeStream was called with high budget
    const call = joule.executeStream.mock.calls[0][0];
    expect(call.budget).toBe('high');
  });
});
