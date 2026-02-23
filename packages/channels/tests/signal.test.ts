import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

// Use BaseChannel subclass to test Signal-like behavior
class TestSignalChannel extends BaseChannel {
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

describe('Signal Channel', () => {
  let channel: TestSignalChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-sig-1',
            result: 'Signal response',
            budgetUsed: {
              tokensUsed: 40,
              energyWh: 0.0004,
              carbonGrams: 0.0002,
              costUsd: 0.001,
              elapsedMs: 180,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-sig-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestSignalChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per phone number', async () => {
    await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'Hello from Signal',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should reuse session for same sender', async () => {
    await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'First message',
      timestamp: new Date().toISOString(),
    });

    mockSessionManager.load.mockResolvedValueOnce({
      id: 'session-sig-1',
      messages: [{ role: 'user', content: 'First message' }],
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'Second message',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Signal response');
    expect(response.text).toContain('Energy:');
    expect(response.text).toContain('Carbon:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata).toBeDefined();
    expect(response.metadata?.taskId).toBe('task-sig-1');
    expect(response.metadata?.tokensUsed).toBe(40);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {
      // No result event
    });

    const response = await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'Fail test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });

  it('should use default budget preset', async () => {
    await channel.testHandle({
      platform: 'signal',
      channelId: '+1234567890',
      userId: '+1234567890',
      username: '+1234567890',
      text: 'Test budget',
      timestamp: new Date().toISOString(),
    });

    const streamCall = mockJoule.executeStream.mock.calls[0][0];
    expect(streamCall.budget).toBe('medium');
  });

  it('should separate sessions for different senders', async () => {
    await channel.testHandle({
      platform: 'signal',
      channelId: '+1111111111',
      userId: '+1111111111',
      username: '+1111111111',
      text: 'From sender A',
      timestamp: new Date().toISOString(),
    });

    await channel.testHandle({
      platform: 'signal',
      channelId: '+2222222222',
      userId: '+2222222222',
      username: '+2222222222',
      text: 'From sender B',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(2);
  });
});
