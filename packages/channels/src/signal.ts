import type { Joule, SessionManager } from '@joule/core';
import type { SignalChannelConfig } from './types.js';
import { BaseChannel } from './base-channel.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

/**
 * Signal channel using signal-cli as the transport layer.
 * Requires signal-cli to be installed and registered.
 * Listens via `signal-cli -a <account> jsonRpc` for incoming messages.
 */
export class SignalChannel extends BaseChannel {
  private config: SignalChannelConfig;
  private process: ChildProcess | null = null;
  private rl: Interface | null = null;
  private running = false;

  constructor(joule: Joule, sessionManager: SessionManager, config: SignalChannelConfig) {
    super(joule, sessionManager, config.budgetPreset);
    this.config = config;
  }

  async start(): Promise<void> {
    const cliPath = this.config.signalCliPath || 'signal-cli';
    const account = this.config.account;

    // Start signal-cli in JSON-RPC mode for streaming messages
    this.process = spawn(cliPath, ['-a', account, 'jsonRpc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.running = true;

    this.rl = createInterface({ input: this.process.stdout! });

    this.rl.on('line', async (line: string) => {
      try {
        const msg = JSON.parse(line);
        await this.handleJsonRpcMessage(msg);
      } catch {
        // Ignore non-JSON lines (signal-cli may output status messages)
      }
    });

    this.process.on('exit', (code) => {
      if (this.running) {
        console.error(`signal-cli exited unexpectedly with code ${code}`);
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        console.warn(`signal-cli stderr: ${text}`);
      }
    });

    console.log(`Signal bot connected (account: ${account})`);
  }

  private async handleJsonRpcMessage(msg: any): Promise<void> {
    // signal-cli jsonRpc sends messages in this format:
    // {"jsonrpc":"2.0","method":"receive","params":{"envelope":{"source":"+1234...","dataMessage":{"message":"text"}}}}
    if (msg.method !== 'receive') return;

    const envelope = msg.params?.envelope;
    if (!envelope?.dataMessage?.message) return;

    const source = envelope.source;
    const text = envelope.dataMessage.message;
    const groupId = envelope.dataMessage.groupInfo?.groupId;

    // Skip group messages unless enabled
    if (groupId && !this.config.allowGroups) return;

    // Filter by allowed numbers
    if (this.config.allowedNumbers && !this.config.allowedNumbers.includes(source)) {
      return;
    }

    const channelId = groupId || source;

    try {
      const response = await this.handleMessage({
        platform: 'signal',
        channelId,
        userId: source,
        username: source,
        text,
        timestamp: new Date().toISOString(),
      });

      // Send reply via signal-cli JSON-RPC
      await this.sendReply(source, response.text, groupId);
    } catch (err) {
      console.error('Signal message error:', err);
      await this.sendReply(source, 'Sorry, an error occurred while processing your message.', groupId);
    }
  }

  private async sendReply(recipient: string, text: string, groupId?: string): Promise<void> {
    if (!this.process?.stdin?.writable) return;

    const request = groupId
      ? {
          jsonrpc: '2.0',
          method: 'send',
          id: Date.now(),
          params: { groupId, message: text },
        }
      : {
          jsonrpc: '2.0',
          method: 'send',
          id: Date.now(),
          params: { recipient, message: text },
        };

    this.process.stdin.write(JSON.stringify(request) + '\n');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    console.log('Signal bot disconnected');
  }
}
