import type { Joule, SessionManager } from '@joule/core';
import type { DiscordChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

const DISCORD_MAX_LENGTH = 2000;

export class DiscordChannel extends BaseChannel {
  private client: any;
  private config: DiscordChannelConfig;

  constructor(joule: Joule, sessionManager: SessionManager, config: DiscordChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    // Dynamic import to avoid requiring discord.js when not used
    const { Client, GatewayIntentBits } = await import('discord.js');

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('ready', () => {
      console.log(`Discord bot connected as ${this.client.user?.tag}`);
    });

    this.client.on('messageCreate', async (message: any) => {
      // Ignore bot messages
      if (message.author.bot) return;

      // Filter by allowed guilds
      if (this.config.allowedGuilds && message.guild &&
          !this.config.allowedGuilds.includes(message.guild.id)) {
        return;
      }

      // Filter by allowed channels
      if (this.config.allowedChannels &&
          !this.config.allowedChannels.includes(message.channel.id)) {
        return;
      }

      // Only respond to mentions or DMs
      const isMention = message.mentions.has(this.client.user);
      const isDM = !message.guild;
      if (!isMention && !isDM) return;

      // Remove bot mention from text
      const text = message.content
        .replace(new RegExp(`<@!?${this.client.user?.id}>`, 'g'), '')
        .trim();

      if (!text) return;

      try {
        // Show typing indicator
        await message.channel.sendTyping();

        const response = await this.handleMessage({
          platform: 'discord',
          channelId: message.channel.id,
          userId: message.author.id,
          username: message.author.username,
          text,
          threadId: message.reference?.messageId,
          timestamp: new Date().toISOString(),
        });

        // Split long messages for Discord's 2000 char limit
        const chunks = splitMessage(response.text, DISCORD_MAX_LENGTH);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } catch (err) {
        console.error('Discord message error:', err);
        await message.reply('Sorry, an error occurred while processing your message.');
      }
    });

    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      console.log('Discord bot disconnected');
    }
  }
}

export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      // Try to split at space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      // Hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
