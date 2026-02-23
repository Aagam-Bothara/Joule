import type { Joule, SessionManager } from '@joule/core';
import type { TeamsChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

/**
 * Microsoft Teams channel using the Bot Framework SDK (botbuilder).
 * Requires an Azure Bot registration with appId and appPassword.
 * Runs a lightweight HTTP server for incoming webhook messages.
 */
export class TeamsChannel extends BaseChannel {
  private config: TeamsChannelConfig;
  private server: any = null;
  private adapter: any = null;

  constructor(joule: Joule, sessionManager: SessionManager, config: TeamsChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const bbMod = 'botbuilder';
    const bb = await import(/* @vite-ignore */ bbMod);
    const { BotFrameworkAdapter, ActivityTypes } = bb;

    this.adapter = new BotFrameworkAdapter({
      appId: this.config.appId,
      appPassword: this.config.appPassword,
    });

    // Error handler
    this.adapter.onTurnError = async (context: any, error: Error) => {
      console.error('Teams bot error:', error);
      await context.sendActivity('Sorry, an error occurred while processing your message.');
    };

    const httpMod = 'node:http';
    const http = await import(/* @vite-ignore */ httpMod);

    const port = this.config.port || 3978;

    this.server = http.createServer(async (req: any, res: any) => {
      if (req.url === '/api/messages' && req.method === 'POST') {
        // Collect body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const body = Buffer.concat(chunks).toString('utf-8');

        // Process through Bot Framework adapter
        try {
          const activity = JSON.parse(body);
          await this.adapter.processActivity(
            { ...req, body: activity, headers: req.headers },
            res,
            async (context: any) => {
              await this.handleActivity(context, ActivityTypes);
            },
          );
        } catch (err) {
          console.error('Teams webhook error:', err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        }
      } else {
        res.writeHead(200);
        res.end('Joule Teams Bot');
      }
    });

    this.server.listen(port, () => {
      console.log(`Teams bot connected (port: ${port})`);
    });
  }

  private async handleActivity(context: any, ActivityTypes: any): Promise<void> {
    if (context.activity.type !== ActivityTypes.Message) return;

    const text = context.activity.text?.trim();
    if (!text) return;

    const conversationId = context.activity.conversation?.id || 'unknown';
    const userId = context.activity.from?.id || 'unknown';
    const username = context.activity.from?.name || context.activity.from?.id || 'unknown';

    // Filter by allowed tenants
    if (this.config.allowedTenants) {
      const tenantId = context.activity.channelData?.tenant?.id;
      if (tenantId && !this.config.allowedTenants.includes(tenantId)) {
        return;
      }
    }

    try {
      const response = await this.handleMessage({
        platform: 'teams',
        channelId: conversationId,
        userId,
        username,
        text,
        timestamp: new Date().toISOString(),
      });

      await context.sendActivity(response.text);
    } catch (err) {
      console.error('Teams message error:', err);
      await context.sendActivity('Sorry, an error occurred while processing your message.');
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
      console.log('Teams bot disconnected');
    }
  }
}
