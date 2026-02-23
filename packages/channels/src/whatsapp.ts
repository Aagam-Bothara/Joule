import type { Joule, SessionManager } from '@joule/core';
import type { WhatsAppChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

export class WhatsAppChannel extends BaseChannel {
  private client: any;
  private config: WhatsAppChannelConfig;
  private ready = false;

  constructor(joule: Joule, sessionManager: SessionManager, config: WhatsAppChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const mod = 'whatsapp-web.js';
    const wwjs = await import(/* @vite-ignore */ mod);
    const Client = wwjs.Client;
    const LocalAuth = wwjs.LocalAuth;

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: this.config.sessionDataPath || '.joule/whatsapp-session',
      }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox'],
      },
    });

    this.client.on('qr', (qr: string) => {
      console.log('WhatsApp: Scan this QR code to connect:');
      // Display QR in terminal using simple ASCII rendering
      printQRtoTerminal(qr);
    });

    this.client.on('ready', () => {
      this.ready = true;
      console.log('WhatsApp bot connected');
    });

    this.client.on('message', async (message: any) => {
      // Ignore group messages unless allowed
      const from = message.from;
      const isGroup = from.endsWith('@g.us');

      if (isGroup) return; // Only handle direct messages by default

      // Filter by allowed numbers
      const phoneNumber = from.replace('@c.us', '');
      if (this.config.allowedNumbers && !this.config.allowedNumbers.includes(phoneNumber)) {
        return;
      }

      const text = message.body;
      if (!text) return;

      try {
        const response = await this.handleMessage({
          platform: 'whatsapp',
          channelId: from,
          userId: phoneNumber,
          username: phoneNumber,
          text,
          timestamp: new Date().toISOString(),
        });

        await message.reply(response.text);
      } catch (err) {
        console.error('WhatsApp message error:', err);
        await message.reply('Sorry, an error occurred while processing your message.');
      }
    });

    await this.client.initialize();
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.ready = false;
      console.log('WhatsApp bot disconnected');
    }
  }

  get isReady(): boolean {
    return this.ready;
  }
}

function printQRtoTerminal(qr: string): void {
  // Simple QR display - users should use a QR code library for production
  console.log('\n' + qr + '\n');
  console.log('(Tip: Install qrcode-terminal for a scannable QR code)\n');
}
