import type { Joule, SessionManager } from '@joule/core';
import type { MatrixChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

/**
 * Matrix channel using matrix-js-sdk.
 * Connects to a Matrix homeserver and listens for room messages.
 * Requires access token and homeserver URL.
 */
export class MatrixChannel extends BaseChannel {
  private config: MatrixChannelConfig;
  private client: any = null;

  constructor(joule: Joule, sessionManager: SessionManager, config: MatrixChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const matrixMod = 'matrix-js-sdk';
    const sdk = await import(/* @vite-ignore */ matrixMod);

    this.client = sdk.createClient({
      baseUrl: this.config.homeserverUrl,
      accessToken: this.config.accessToken,
      userId: this.config.userId,
    });

    this.client.on('Room.timeline', async (event: any, room: any) => {
      // Only handle text messages
      if (event.getType() !== 'm.room.message') return;

      const content = event.getContent();
      if (content.msgtype !== 'm.text') return;

      // Ignore own messages
      if (event.getSender() === this.config.userId) return;

      const roomId = room.roomId;
      const senderId = event.getSender();
      const text = content.body;

      // Filter by allowed rooms
      if (this.config.allowedRooms && !this.config.allowedRooms.includes(roomId)) {
        return;
      }

      if (!text) return;

      try {
        const response = await this.handleMessage({
          platform: 'matrix',
          channelId: roomId,
          userId: senderId,
          username: senderId,
          text,
          timestamp: new Date().toISOString(),
        });

        await this.client.sendTextMessage(roomId, response.text);
      } catch (err) {
        console.error('Matrix message error:', err);
        await this.client.sendTextMessage(
          roomId,
          'Sorry, an error occurred while processing your message.',
        );
      }
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    console.log(`Matrix bot connected (${this.config.userId})`);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
      console.log('Matrix bot disconnected');
    }
  }
}
