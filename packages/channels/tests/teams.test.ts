import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

class TestTeamsChannel extends BaseChannel {
  public started = false;
  public stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async testHandle(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('Teams Channel', () => {
  let channel: TestTeamsChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-teams-1',
            result: 'Teams response',
            budgetUsed: {
              tokensUsed: 60,
              energyWh: 0.0006,
              carbonGrams: 0.0004,
              costUsd: 0.002,
              elapsedMs: 250,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-teams-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestTeamsChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per conversation', async () => {
    await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John Doe',
      text: 'Hello from Teams',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should reuse session for same conversation', async () => {
    await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John Doe',
      text: 'First message',
      timestamp: new Date().toISOString(),
    });

    mockSessionManager.load.mockResolvedValueOnce({
      id: 'session-teams-1',
      messages: [{ role: 'user', content: 'First message' }],
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John Doe',
      text: 'Second message',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John Doe',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Teams response');
    expect(response.text).toContain('Energy:');
    expect(response.text).toContain('Carbon:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John Doe',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata).toBeDefined();
    expect(response.metadata?.taskId).toBe('task-teams-1');
    expect(response.metadata?.tokensUsed).toBe(60);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {
      // No result event
    });

    const response = await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John Doe',
      text: 'Fail test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });

  it('should separate sessions for different conversations', async () => {
    await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-aaa',
      userId: 'user-1',
      username: 'Alice',
      text: 'Conversation A',
      timestamp: new Date().toISOString(),
    });

    await channel.testHandle({
      platform: 'teams',
      channelId: 'conv-bbb',
      userId: 'user-2',
      username: 'Bob',
      text: 'Conversation B',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(2);
  });

  it('should use custom budget preset', async () => {
    const customChannel = new TestTeamsChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
      'low',
    );

    await customChannel.testHandle({
      platform: 'teams',
      channelId: 'conv-123',
      userId: 'user-1',
      username: 'John',
      text: 'Test budget',
      timestamp: new Date().toISOString(),
    });

    const streamCall = mockJoule.executeStream.mock.calls[0][0];
    expect(streamCall.budget).toBe('low');
  });
});
