import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

// Use BaseChannel subclass to test WhatsApp-like behavior
class TestWhatsAppChannel extends BaseChannel {
  public started = false;
  public stopped = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  // Expose handleMessage for testing
  async testHandle(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('WhatsApp Channel', () => {
  let channel: TestWhatsAppChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-1',
            result: 'WhatsApp response',
            budgetUsed: {
              tokensUsed: 50,
              energyWh: 0.0005,
              carbonGrams: 0.0003,
              costUsd: 0.001,
              elapsedMs: 200,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-wa-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestWhatsAppChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per phone number', async () => {
    await channel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'Hello from WhatsApp',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should reuse session for same phone number', async () => {
    await channel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'First message',
      timestamp: new Date().toISOString(),
    });

    // Second load should find existing session
    mockSessionManager.load.mockResolvedValueOnce({
      id: 'session-wa-1',
      messages: [{ role: 'user', content: 'First message' }],
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    await channel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'Second message',
      timestamp: new Date().toISOString(),
    });

    // Should only create one session (second uses existing)
    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('WhatsApp response');
    expect(response.text).toContain('Energy:');
    expect(response.text).toContain('Carbon:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata).toBeDefined();
    expect(response.metadata?.taskId).toBe('task-1');
    expect(response.metadata?.tokensUsed).toBe(50);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {
      // No result event
    });

    const response = await channel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'Fail test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });

  it('should use default budget preset', async () => {
    const defaultChannel = new TestWhatsAppChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );

    await defaultChannel.testHandle({
      platform: 'whatsapp',
      channelId: '1234567890@c.us',
      userId: '1234567890',
      username: '1234567890',
      text: 'Test budget',
      timestamp: new Date().toISOString(),
    });

    // Verify task was created with medium budget
    const streamCall = mockJoule.executeStream.mock.calls[0][0];
    expect(streamCall.budget).toBe('medium');
  });
});
