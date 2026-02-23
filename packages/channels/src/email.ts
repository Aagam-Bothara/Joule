import type { Joule, SessionManager } from '@joule/core';
import type { EmailChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';

/**
 * Email channel using IMAP for receiving and SMTP for sending.
 * Uses nodemailer (SMTP) and imap (IMAP) — both dynamically imported.
 * Polls IMAP inbox at a configurable interval for new unread messages.
 */
export class EmailChannel extends BaseChannel {
  private config: EmailChannelConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private imapClient: any = null;
  private transporter: any = null;
  private processedUids = new Set<number>();

  constructor(joule: Joule, sessionManager: SessionManager, config: EmailChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    // Set up SMTP transporter via nodemailer
    const nodemailerMod = 'nodemailer';
    const nodemailer = await import(/* @vite-ignore */ nodemailerMod);

    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port || 587,
      secure: this.config.smtp.secure ?? false,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.pass,
      },
    });

    // Start IMAP polling
    const pollIntervalMs = this.config.pollIntervalMs || 30_000; // default 30s
    this.pollTimer = setInterval(() => this.pollInbox(), pollIntervalMs);

    // Initial poll
    await this.pollInbox();

    console.log(`Email bot connected (${this.config.smtp.user})`);
  }

  private async pollInbox(): Promise<void> {
    try {
      const imapMod = 'imap';
      const Imap = (await import(/* @vite-ignore */ imapMod)).default;

      await new Promise<void>((resolve, reject) => {
        this.imapClient = new Imap({
          user: this.config.imap.user,
          password: this.config.imap.pass,
          host: this.config.imap.host,
          port: this.config.imap.port || 993,
          tls: this.config.imap.tls ?? true,
          tlsOptions: { rejectUnauthorized: false },
        });

        this.imapClient.once('ready', () => {
          this.imapClient.openBox('INBOX', false, (err: any) => {
            if (err) {
              this.imapClient.end();
              reject(err);
              return;
            }
            this.fetchUnread().then(() => {
              this.imapClient.end();
              resolve();
            }).catch((fetchErr: Error) => {
              this.imapClient.end();
              reject(fetchErr);
            });
          });
        });

        this.imapClient.once('error', (err: Error) => {
          reject(err);
        });

        this.imapClient.connect();
      });
    } catch (err) {
      console.error('Email IMAP poll error:', err);
    }
  }

  private async fetchUnread(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.imapClient.search(['UNSEEN'], (err: any, uids: number[]) => {
        if (err) { reject(err); return; }
        if (!uids || uids.length === 0) { resolve(); return; }

        const newUids = uids.filter((uid) => !this.processedUids.has(uid));
        if (newUids.length === 0) { resolve(); return; }

        const fetch = this.imapClient.fetch(newUids, { bodies: '', markSeen: true });
        const messages: Array<{ uid: number; from: string; subject: string; body: string }> = [];

        fetch.on('message', (msg: any, seqno: number) => {
          let buffer = '';
          let uid = 0;

          msg.on('body', (stream: any) => {
            stream.on('data', (chunk: Buffer) => {
              buffer += chunk.toString('utf-8');
            });
          });

          msg.once('attributes', (attrs: any) => {
            uid = attrs.uid;
          });

          msg.once('end', () => {
            const parsed = this.parseEmail(buffer);
            messages.push({ uid, ...parsed });
          });
        });

        fetch.once('end', async () => {
          for (const msg of messages) {
            this.processedUids.add(msg.uid);
            await this.handleEmailMessage(msg);
          }
          resolve();
        });

        fetch.once('error', (fetchErr: Error) => {
          reject(fetchErr);
        });
      });
    });
  }

  /** Simple email header/body parser (handles basic plain-text emails) */
  parseEmail(raw: string): { from: string; subject: string; body: string } {
    const headerEnd = raw.indexOf('\r\n\r\n');
    const headers = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
    const body = headerEnd >= 0 ? raw.slice(headerEnd + 4).trim() : '';

    const fromMatch = headers.match(/^From:\s*(.+)$/im);
    const subjectMatch = headers.match(/^Subject:\s*(.+)$/im);

    // Extract email address from "Name <email@example.com>" or plain email
    const fromRaw = fromMatch?.[1]?.trim() || 'unknown';
    const emailMatch = fromRaw.match(/<([^>]+)>/);
    const from = emailMatch ? emailMatch[1] : fromRaw;

    return {
      from,
      subject: subjectMatch?.[1]?.trim() || '(no subject)',
      body,
    };
  }

  private async handleEmailMessage(msg: { uid: number; from: string; subject: string; body: string }): Promise<void> {
    // Filter by allowed senders
    if (this.config.allowedSenders && !this.config.allowedSenders.includes(msg.from)) {
      return;
    }

    const text = msg.subject !== '(no subject)'
      ? `Subject: ${msg.subject}\n\n${msg.body}`
      : msg.body;

    if (!text.trim()) return;

    try {
      const response = await this.handleMessage({
        platform: 'email',
        channelId: msg.from,
        userId: msg.from,
        username: msg.from,
        text,
        timestamp: new Date().toISOString(),
      });

      // Send reply via SMTP
      await this.transporter.sendMail({
        from: this.config.smtp.user,
        to: msg.from,
        subject: `Re: ${msg.subject}`,
        text: response.text,
      });
    } catch (err) {
      console.error('Email reply error:', err);
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.imapClient) {
      try { this.imapClient.end(); } catch { /* ignore */ }
      this.imapClient = null;
    }
    this.transporter = null;
    console.log('Email bot disconnected');
  }
}
