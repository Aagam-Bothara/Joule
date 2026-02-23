import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

class TestIrcChannel extends BaseChannel {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async testHandle(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('IRC Channel', () => {
  let channel: TestIrcChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-irc-1',
            result: 'IRC response',
            budgetUsed: {
              tokensUsed: 30,
              energyWh: 0.0003,
              carbonGrams: 0.0002,
              costUsd: 0.001,
              elapsedMs: 150,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-irc-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestIrcChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per IRC channel', async () => {
    await channel.testHandle({
      platform: 'irc',
      channelId: '#general',
      userId: 'user1',
      username: 'user1',
      text: 'Hello from IRC',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'irc',
      channelId: '#general',
      userId: 'user1',
      username: 'user1',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('IRC response');
    expect(response.text).toContain('Energy:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'irc',
      channelId: '#general',
      userId: 'user1',
      username: 'user1',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata?.taskId).toBe('task-irc-1');
  });

  it('should separate sessions for different channels', async () => {
    await channel.testHandle({
      platform: 'irc',
      channelId: '#general',
      userId: 'user1',
      username: 'user1',
      text: 'A',
      timestamp: new Date().toISOString(),
    });

    await channel.testHandle({
      platform: 'irc',
      channelId: '#random',
      userId: 'user1',
      username: 'user1',
      text: 'B',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(2);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {});

    const response = await channel.testHandle({
      platform: 'irc',
      channelId: '#general',
      userId: 'user1',
      username: 'user1',
      text: 'Fail',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });
});
