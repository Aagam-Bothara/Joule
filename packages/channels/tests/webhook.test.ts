import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

class TestWebhookChannel extends BaseChannel {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async testHandle(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('Webhook Channel', () => {
  let channel: TestWebhookChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-wh-1',
            result: 'Webhook response',
            budgetUsed: {
              tokensUsed: 35,
              energyWh: 0.0003,
              carbonGrams: 0.0002,
              costUsd: 0.001,
              elapsedMs: 120,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-wh-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestWebhookChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per channel ID', async () => {
    await channel.testHandle({
      platform: 'webhook',
      channelId: 'webhook-default',
      userId: 'ext-user',
      username: 'External User',
      text: 'Hello from webhook',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'webhook',
      channelId: 'webhook-default',
      userId: 'ext-user',
      username: 'External User',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Webhook response');
    expect(response.text).toContain('Energy:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'webhook',
      channelId: 'webhook-default',
      userId: 'ext-user',
      username: 'External User',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata?.taskId).toBe('task-wh-1');
  });

  it('should support thread IDs', async () => {
    const response = await channel.testHandle({
      platform: 'webhook',
      channelId: 'webhook-default',
      userId: 'ext-user',
      username: 'External User',
      text: 'Test',
      threadId: 'thread-123',
      timestamp: new Date().toISOString(),
    });

    expect(response.threadId).toBe('thread-123');
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {});

    const response = await channel.testHandle({
      platform: 'webhook',
      channelId: 'webhook-default',
      userId: 'ext-user',
      username: 'External User',
      text: 'Fail',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });
});
