import type { Joule, SessionManager } from '@joule/core';
import type { TelegramChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

const TELEGRAM_MAX_LENGTH = 4096;

export class TelegramChannel extends BaseChannel {
  private bot: any;
  private config: TelegramChannelConfig;

  constructor(joule: Joule, sessionManager: SessionManager, config: TelegramChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const mod = 'telegraf';
    const { Telegraf } = await import(/* @vite-ignore */ mod);

    this.bot = new Telegraf(this.config.botToken);

    this.bot.on('text', async (ctx: any) => {
      const chatId = String(ctx.chat.id);

      // Filter by allowed chats
      if (this.config.allowedChats && !this.config.allowedChats.includes(chatId)) {
        return;
      }

      const text = ctx.message.text;
      if (!text) return;

      try {
        const response = await this.handleMessage({
          platform: 'telegram',
          channelId: chatId,
          userId: String(ctx.from.id),
          username: ctx.from.username || ctx.from.first_name || 'unknown',
          text,
          timestamp: new Date().toISOString(),
        });

        // Split long messages for Telegram's 4096 char limit
        const chunks = splitTelegramMessage(response.text, TELEGRAM_MAX_LENGTH);
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      } catch (err) {
        console.error('Telegram message error:', err);
        await ctx.reply('Sorry, an error occurred while processing your message.');
      }
    });

    await this.bot.launch();
    console.log('Telegram bot connected');
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      console.log('Telegram bot disconnected');
    }
  }
}

export function splitTelegramMessage(text: string, maxLength: number): string[] {
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
