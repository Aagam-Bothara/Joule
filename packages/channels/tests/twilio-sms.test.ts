import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

class TestTwilioChannel extends BaseChannel {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async testHandle(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('Twilio SMS Channel', () => {
  let channel: TestTwilioChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-sms-1',
            result: 'SMS response',
            budgetUsed: {
              tokensUsed: 25,
              energyWh: 0.0002,
              carbonGrams: 0.0001,
              costUsd: 0.001,
              elapsedMs: 100,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-sms-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestTwilioChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per phone number', async () => {
    await channel.testHandle({
      platform: 'twilio-sms',
      channelId: '+15551234567',
      userId: '+15551234567',
      username: '+15551234567',
      text: 'Hello via SMS',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'twilio-sms',
      channelId: '+15551234567',
      userId: '+15551234567',
      username: '+15551234567',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('SMS response');
    expect(response.text).toContain('Energy:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'twilio-sms',
      channelId: '+15551234567',
      userId: '+15551234567',
      username: '+15551234567',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata?.taskId).toBe('task-sms-1');
    expect(response.metadata?.tokensUsed).toBe(25);
  });

  it('should separate sessions for different numbers', async () => {
    await channel.testHandle({
      platform: 'twilio-sms',
      channelId: '+15551111111',
      userId: '+15551111111',
      username: '+15551111111',
      text: 'A',
      timestamp: new Date().toISOString(),
    });

    await channel.testHandle({
      platform: 'twilio-sms',
      channelId: '+15552222222',
      userId: '+15552222222',
      username: '+15552222222',
      text: 'B',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(2);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {});

    const response = await channel.testHandle({
      platform: 'twilio-sms',
      channelId: '+15551234567',
      userId: '+15551234567',
      username: '+15551234567',
      text: 'Fail',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });
});
