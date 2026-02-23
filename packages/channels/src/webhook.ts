import type { Joule, SessionManager } from '@joule/core';
import type { WebhookChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

/**
 * Generic Webhook channel.
 * Exposes an HTTP endpoint that accepts JSON POST requests and returns AI responses.
 * Works with any service that can send/receive HTTP webhooks.
 *
 * Inbound format: POST /webhook
 *   { "text": "message", "userId": "user-1", "channelId": "chan-1", "username": "User" }
 *
 * Response format:
 *   { "text": "response", "metadata": { ... } }
 */
export class WebhookChannel extends BaseChannel {
  private config: WebhookChannelConfig;
  private server: any = null;

  constructor(joule: Joule, sessionManager: SessionManager, config: WebhookChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const httpMod = 'node:http';
    const http = await import(/* @vite-ignore */ httpMod);
    const port = this.config.port || 3081;
    const path = this.config.path || '/webhook';

    this.server = http.createServer(async (req: any, res: any) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      if (req.url === path && req.method === 'POST') {
        await this.handleWebhookRequest(req, res);
      } else if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', platform: 'webhook' }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this.server.listen(port, () => {
      console.log(`Webhook channel listening on port ${port} at ${path}`);
    });
  }

  private async handleWebhookRequest(req: any, res: any): Promise<void> {
    try {
      // Validate secret if configured
      if (this.config.secret) {
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${this.config.secret}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Parse JSON body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

      const text = body.text || body.message || body.content || '';
      if (!text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing text field' }));
        return;
      }

      const userId = body.userId || body.user_id || body.user || 'webhook-user';
      const channelId = body.channelId || body.channel_id || body.channel || 'webhook-default';
      const username = body.username || body.name || userId;

      const response = await this.handleMessage({
        platform: 'webhook',
        channelId,
        userId,
        username,
        text,
        threadId: body.threadId || body.thread_id,
        timestamp: new Date().toISOString(),
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        text: response.text,
        threadId: response.threadId,
        metadata: response.metadata,
      }));
    } catch (err) {
      console.error('Webhook error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
      console.log('Webhook channel stopped');
    }
  }
}
