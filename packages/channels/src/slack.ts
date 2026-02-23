import type { Joule, SessionManager } from '@joule/core';
import type { SlackChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

export class SlackChannel extends BaseChannel {
  private app: any;
  private config: SlackChannelConfig;

  constructor(joule: Joule, sessionManager: SessionManager, config: SlackChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    // Dynamic import to avoid requiring @slack/bolt when not used
    const { App } = await import('@slack/bolt');

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      signingSecret: this.config.signingSecret,
    });

    // Listen for messages
    this.app.message(async ({ message, say }: any) => {
      // Skip bot messages
      if (message.subtype === 'bot_message' || message.bot_id) return;

      // Filter by allowed channels
      if (this.config.allowedChannels && !this.config.allowedChannels.includes(message.channel)) {
        return;
      }

      try {
        const response = await this.handleMessage({
          platform: 'slack',
          channelId: message.channel,
          userId: message.user,
          username: message.user,
          text: message.text ?? '',
          threadId: message.thread_ts ?? message.ts,
          timestamp: new Date().toISOString(),
        });

        await say({
          text: response.text,
          thread_ts: response.threadId,
        });
      } catch (err) {
        console.error('Slack message error:', err);
        await say({
          text: 'Sorry, an error occurred while processing your message.',
          thread_ts: message.thread_ts ?? message.ts,
        });
      }
    });

    await this.app.start();
    console.log('Slack bot connected (Socket Mode)');
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      console.log('Slack bot disconnected');
    }
  }
}
