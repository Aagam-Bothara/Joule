import type { Joule, SessionManager } from '@joule/core';
import type { IrcChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

/**
 * IRC channel using irc-framework.
 * Connects to an IRC server and listens for messages in specified channels.
 */
export class IrcChannel extends BaseChannel {
  private config: IrcChannelConfig;
  private client: any = null;

  constructor(joule: Joule, sessionManager: SessionManager, config: IrcChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const ircMod = 'irc-framework';
    const irc = await import(/* @vite-ignore */ ircMod);
    const Client = irc.Client || irc.default?.Client || irc.default;

    this.client = new Client();

    this.client.connect({
      host: this.config.server,
      port: this.config.port || 6667,
      nick: this.config.nick,
      tls: this.config.tls ?? false,
    });

    this.client.on('registered', () => {
      // Join configured channels
      const channels = this.config.channels || [];
      for (const chan of channels) {
        this.client.join(chan);
      }
      console.log(`IRC bot connected (${this.config.nick}@${this.config.server})`);
    });

    this.client.on('privmsg', async (event: any) => {
      const nick = event.nick;
      const target = event.target;
      const text = event.message;

      if (!text) return;

      // Filter: only respond in configured channels or DMs
      const isDM = target === this.config.nick;
      const isAllowedChannel = !this.config.channels || this.config.channels.includes(target);

      if (!isDM && !isAllowedChannel) return;

      // In channels, only respond when mentioned or prefixed
      if (!isDM && this.config.requireMention) {
        const prefix = `${this.config.nick}:`;
        const prefixAlt = `${this.config.nick},`;
        if (!text.startsWith(prefix) && !text.startsWith(prefixAlt)) return;
      }

      const channelId = isDM ? nick : target;
      const cleanText = isDM ? text : text.replace(new RegExp(`^${this.config.nick}[,:] *`), '');

      try {
        const response = await this.handleMessage({
          platform: 'irc',
          channelId,
          userId: nick,
          username: nick,
          text: cleanText,
          timestamp: new Date().toISOString(),
        });

        // Split long messages (IRC has ~512 byte limit per line)
        const lines = response.text.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            this.client.say(channelId, line);
          }
        }
      } catch (err) {
        console.error('IRC message error:', err);
        this.client.say(channelId, 'Sorry, an error occurred while processing your message.');
      }
    });
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.quit('Joule shutting down');
      this.client = null;
      console.log('IRC bot disconnected');
    }
  }
}
