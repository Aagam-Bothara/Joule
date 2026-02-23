import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

class TestMatrixChannel extends BaseChannel {
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

describe('Matrix Channel', () => {
  let channel: TestMatrixChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-mx-1',
            result: 'Matrix response',
            budgetUsed: {
              tokensUsed: 55,
              energyWh: 0.0005,
              carbonGrams: 0.0003,
              costUsd: 0.001,
              elapsedMs: 190,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-mx-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestMatrixChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per room', async () => {
    await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'Hello from Matrix',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should reuse session for same room', async () => {
    await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'First message',
      timestamp: new Date().toISOString(),
    });

    mockSessionManager.load.mockResolvedValueOnce({
      id: 'session-mx-1',
      messages: [{ role: 'user', content: 'First message' }],
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'Second message',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Matrix response');
    expect(response.text).toContain('Energy:');
    expect(response.text).toContain('Carbon:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata).toBeDefined();
    expect(response.metadata?.taskId).toBe('task-mx-1');
    expect(response.metadata?.tokensUsed).toBe(55);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {
      // No result event
    });

    const response = await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'Fail test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });

  it('should separate sessions for different rooms', async () => {
    await channel.testHandle({
      platform: 'matrix',
      channelId: '!roomA:matrix.org',
      userId: '@alice:matrix.org',
      username: '@alice:matrix.org',
      text: 'Room A message',
      timestamp: new Date().toISOString(),
    });

    await channel.testHandle({
      platform: 'matrix',
      channelId: '!roomB:matrix.org',
      userId: '@bob:matrix.org',
      username: '@bob:matrix.org',
      text: 'Room B message',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(2);
  });

  it('should use default budget preset', async () => {
    await channel.testHandle({
      platform: 'matrix',
      channelId: '!room1:matrix.org',
      userId: '@user:matrix.org',
      username: '@user:matrix.org',
      text: 'Test budget',
      timestamp: new Date().toISOString(),
    });

    const streamCall = mockJoule.executeStream.mock.calls[0][0];
    expect(streamCall.budget).toBe('medium');
  });
});
