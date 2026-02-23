import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import { EmailChannel } from '../src/email.js';
import type { ChannelMessage, ChannelResponse } from '../src/types.js';

class TestEmailChannel extends BaseChannel {
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

describe('Email Channel', () => {
  let channel: TestEmailChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-email-1',
            result: 'Email response',
            budgetUsed: {
              tokensUsed: 45,
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
        id: 'session-email-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestEmailChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should create a session per email sender', async () => {
    await channel.testHandle({
      platform: 'email',
      channelId: 'alice@example.com',
      userId: 'alice@example.com',
      username: 'alice@example.com',
      text: 'Subject: Hello\n\nHello from email',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalled();
  });

  it('should reuse session for same sender', async () => {
    await channel.testHandle({
      platform: 'email',
      channelId: 'bob@example.com',
      userId: 'bob@example.com',
      username: 'bob@example.com',
      text: 'First email',
      timestamp: new Date().toISOString(),
    });

    mockSessionManager.load.mockResolvedValueOnce({
      id: 'session-email-1',
      messages: [{ role: 'user', content: 'First email' }],
      createdAt: new Date().toISOString(),
      metadata: {},
    });

    await channel.testHandle({
      platform: 'email',
      channelId: 'bob@example.com',
      userId: 'bob@example.com',
      username: 'bob@example.com',
      text: 'Second email',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(1);
  });

  it('should include energy footer in response', async () => {
    const response = await channel.testHandle({
      platform: 'email',
      channelId: 'test@example.com',
      userId: 'test@example.com',
      username: 'test@example.com',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Email response');
    expect(response.text).toContain('Energy:');
    expect(response.text).toContain('Carbon:');
  });

  it('should include metadata in response', async () => {
    const response = await channel.testHandle({
      platform: 'email',
      channelId: 'test@example.com',
      userId: 'test@example.com',
      username: 'test@example.com',
      text: 'Test',
      timestamp: new Date().toISOString(),
    });

    expect(response.metadata).toBeDefined();
    expect(response.metadata?.taskId).toBe('task-email-1');
    expect(response.metadata?.tokensUsed).toBe(45);
  });

  it('should handle execution failures gracefully', async () => {
    mockJoule.executeStream = vi.fn().mockImplementation(async function* () {
      // No result event
    });

    const response = await channel.testHandle({
      platform: 'email',
      channelId: 'test@example.com',
      userId: 'test@example.com',
      username: 'test@example.com',
      text: 'Fail test',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('unable to process');
  });

  it('should separate sessions for different senders', async () => {
    await channel.testHandle({
      platform: 'email',
      channelId: 'alice@example.com',
      userId: 'alice@example.com',
      username: 'alice@example.com',
      text: 'From Alice',
      timestamp: new Date().toISOString(),
    });

    await channel.testHandle({
      platform: 'email',
      channelId: 'bob@example.com',
      userId: 'bob@example.com',
      username: 'bob@example.com',
      text: 'From Bob',
      timestamp: new Date().toISOString(),
    });

    expect(mockSessionManager.create).toHaveBeenCalledTimes(2);
  });
});

describe('Email parseEmail', () => {
  let emailChannel: EmailChannel;

  beforeEach(() => {
    const mockJoule = { executeStream: vi.fn() } as any;
    const mockSM = {
      create: vi.fn(), load: vi.fn(), save: vi.fn(),
      addMessage: vi.fn(), updateMetadata: vi.fn(),
    } as any;
    emailChannel = new EmailChannel(mockJoule, mockSM, {
      imap: { host: 'imap.test.com', user: 'test', pass: 'pass' },
      smtp: { host: 'smtp.test.com', user: 'test@test.com', pass: 'pass' },
    });
  });

  it('should parse basic email with From and Subject', () => {
    const raw = 'From: Alice <alice@example.com>\r\nSubject: Hello World\r\n\r\nThis is the body.';
    const parsed = emailChannel.parseEmail(raw);

    expect(parsed.from).toBe('alice@example.com');
    expect(parsed.subject).toBe('Hello World');
    expect(parsed.body).toBe('This is the body.');
  });

  it('should parse email with plain email address (no angle brackets)', () => {
    const raw = 'From: bob@example.com\r\nSubject: Test\r\n\r\nBody text';
    const parsed = emailChannel.parseEmail(raw);

    expect(parsed.from).toBe('bob@example.com');
    expect(parsed.subject).toBe('Test');
    expect(parsed.body).toBe('Body text');
  });

  it('should handle missing subject', () => {
    const raw = 'From: test@test.com\r\n\r\nJust body';
    const parsed = emailChannel.parseEmail(raw);

    expect(parsed.from).toBe('test@test.com');
    expect(parsed.subject).toBe('(no subject)');
    expect(parsed.body).toBe('Just body');
  });

  it('should handle empty body', () => {
    const raw = 'From: test@test.com\r\nSubject: Empty\r\n\r\n';
    const parsed = emailChannel.parseEmail(raw);

    expect(parsed.from).toBe('test@test.com');
    expect(parsed.subject).toBe('Empty');
    expect(parsed.body).toBe('');
  });
});
