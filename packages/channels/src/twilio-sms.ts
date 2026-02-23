import type { Joule, SessionManager } from '@joule/core';
import type { TwilioSmsChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

/**
 * Twilio SMS channel.
 * Runs an HTTP webhook server for inbound SMS and uses Twilio REST API for outbound.
 */
export class TwilioSmsChannel extends BaseChannel {
  private config: TwilioSmsChannelConfig;
  private server: any = null;
  private twilioClient: any = null;

  constructor(joule: Joule, sessionManager: SessionManager, config: TwilioSmsChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    // Initialize Twilio client for sending SMS
    const twilioMod = 'twilio';
    const twilio = await import(/* @vite-ignore */ twilioMod);
    const TwilioClient = twilio.default || twilio;
    this.twilioClient = new TwilioClient(this.config.accountSid, this.config.authToken);

    // Start HTTP server for inbound webhooks
    const httpMod = 'node:http';
    const http = await import(/* @vite-ignore */ httpMod);
    const port = this.config.webhookPort || 3080;

    this.server = http.createServer(async (req: any, res: any) => {
      if (req.url === '/sms' && req.method === 'POST') {
        await this.handleWebhook(req, res);
      } else {
        res.writeHead(200);
        res.end('Joule Twilio SMS Bot');
      }
    });

    this.server.listen(port, () => {
      console.log(`Twilio SMS bot connected (webhook port: ${port})`);
    });
  }

  private async handleWebhook(req: any, res: any): Promise<void> {
    try {
      // Parse URL-encoded form body from Twilio
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks).toString('utf-8');
      const params = new URLSearchParams(body);

      const from = params.get('From') || '';
      const text = params.get('Body') || '';
      const messageSid = params.get('MessageSid') || '';

      if (!text.trim()) {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<Response></Response>');
        return;
      }

      // Filter by allowed numbers
      if (this.config.allowedNumbers && !this.config.allowedNumbers.includes(from)) {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end('<Response></Response>');
        return;
      }

      const response = await this.handleMessage({
        platform: 'twilio-sms',
        channelId: from,
        userId: from,
        username: from,
        text,
        timestamp: new Date().toISOString(),
      });

      // Send reply via Twilio API (supports longer messages than TwiML)
      await this.twilioClient.messages.create({
        body: response.text,
        from: this.config.phoneNumber,
        to: from,
      });

      // Return empty TwiML (we already sent reply via API)
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response></Response>');
    } catch (err) {
      console.error('Twilio SMS webhook error:', err);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end('<Response><Message>Sorry, an error occurred.</Message></Response>');
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
      console.log('Twilio SMS bot disconnected');
    }
  }
}
