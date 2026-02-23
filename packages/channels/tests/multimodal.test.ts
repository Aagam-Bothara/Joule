import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Joule, SessionManager } from '@joule/core';
import { BaseChannel } from '../src/base-channel.js';
import type { ChannelMessage, ChannelResponse, Attachment } from '../src/types.js';

class TestMultimodalChannel extends BaseChannel {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async testHandle(msg: ChannelMessage): Promise<ChannelResponse> {
    return this.handleMessage(msg);
  }
}

describe('Multi-modal Support', () => {
  let channel: TestMultimodalChannel;
  let mockJoule: any;
  let mockSessionManager: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'task-mm-1',
            result: 'Processed with attachments',
            budgetUsed: {
              tokensUsed: 50,
              energyWh: 0.0005,
              carbonGrams: 0.0003,
              costUsd: 0.002,
              elapsedMs: 300,
            },
          },
        };
      }),
    };

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        id: 'session-mm-1',
        messages: [],
        createdAt: new Date().toISOString(),
        metadata: {},
      }),
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      addMessage: vi.fn(),
      updateMetadata: vi.fn(),
    };

    channel = new TestMultimodalChannel(
      mockJoule as unknown as Joule,
      mockSessionManager as unknown as SessionManager,
    );
  });

  it('should handle messages without attachments normally', async () => {
    const response = await channel.testHandle({
      platform: 'webhook',
      channelId: 'test',
      userId: 'user-1',
      username: 'User',
      text: 'Hello',
      timestamp: new Date().toISOString(),
    });

    expect(response.text).toContain('Processed with attachments');

    // Verify message was added without attachment description
    const addMessageCall = mockSessionManager.addMessage.mock.calls[0];
    expect(addMessageCall[1].content).toBe('Hello');
  });

  it('should include image attachment description in message content', async () => {
    const attachments: Attachment[] = [
      {
        type: 'image',
        mimeType: 'image/png',
        filename: 'screenshot.png',
        size: 1024,
      },
    ];

    await channel.testHandle({
      platform: 'webhook',
      channelId: 'test',
      userId: 'user-1',
      username: 'User',
      text: 'What is this?',
      timestamp: new Date().toISOString(),
      attachments,
    });

    const addMessageCall = mockSessionManager.addMessage.mock.calls[0];
    expect(addMessageCall[1].content).toContain('What is this?');
    expect(addMessageCall[1].content).toContain('Attachments:');
    expect(addMessageCall[1].content).toContain('[Image: screenshot.png (image/png)]');
  });

  it('should include multiple attachment descriptions', async () => {
    const attachments: Attachment[] = [
      { type: 'image', mimeType: 'image/jpeg', filename: 'photo.jpg' },
      { type: 'document', mimeType: 'application/pdf', filename: 'report.pdf' },
      { type: 'audio', mimeType: 'audio/mp3', filename: 'voice.mp3' },
    ];

    await channel.testHandle({
      platform: 'webhook',
      channelId: 'test',
      userId: 'user-1',
      username: 'User',
      text: 'Check these files',
      timestamp: new Date().toISOString(),
      attachments,
    });

    const addMessageCall = mockSessionManager.addMessage.mock.calls[0];
    const content = addMessageCall[1].content;
    expect(content).toContain('[Image: photo.jpg (image/jpeg)]');
    expect(content).toContain('[Document: report.pdf (application/pdf)]');
    expect(content).toContain('[Audio: voice.mp3 (audio/mp3)]');
  });

  it('should handle attachment without filename', async () => {
    const attachments: Attachment[] = [
      { type: 'file', mimeType: 'application/octet-stream' },
    ];

    await channel.testHandle({
      platform: 'webhook',
      channelId: 'test',
      userId: 'user-1',
      username: 'User',
      text: 'What is this file?',
      timestamp: new Date().toISOString(),
      attachments,
    });

    const addMessageCall = mockSessionManager.addMessage.mock.calls[0];
    expect(addMessageCall[1].content).toContain('[File: unnamed (application/octet-stream)]');
  });

  it('should pass attachment-enriched content to task description', async () => {
    const attachments: Attachment[] = [
      { type: 'image', mimeType: 'image/png', filename: 'chart.png' },
    ];

    await channel.testHandle({
      platform: 'webhook',
      channelId: 'test',
      userId: 'user-1',
      username: 'User',
      text: 'Analyze this chart',
      timestamp: new Date().toISOString(),
      attachments,
    });

    // Verify the task description includes attachment info
    const executeCall = mockJoule.executeStream.mock.calls[0][0];
    expect(executeCall.description).toContain('Analyze this chart');
    expect(executeCall.description).toContain('[Image: chart.png (image/png)]');
  });

  it('should handle video and file attachments', async () => {
    const attachments: Attachment[] = [
      { type: 'video', mimeType: 'video/mp4', filename: 'clip.mp4', size: 5000000 },
    ];

    await channel.testHandle({
      platform: 'webhook',
      channelId: 'test',
      userId: 'user-1',
      username: 'User',
      text: 'Check this video',
      timestamp: new Date().toISOString(),
      attachments,
    });

    const addMessageCall = mockSessionManager.addMessage.mock.calls[0];
    expect(addMessageCall[1].content).toContain('[Video: clip.mp4 (video/mp4)]');
  });
});
