import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDefinition } from '@joule/shared';
import { createTransport, type McpTransportConfig } from './transport.js';
import { mcpToolToJouleToolDefinition } from './schema-bridge.js';

export interface McpServerConfig {
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export class McpClient {
  private client: Client;
  private transport: Transport | null = null;
  private connected = false;
  private serverName: string;

  constructor(serverName: string) {
    this.serverName = serverName;
    this.client = new Client(
      { name: 'joule', version: '0.1.0' },
      { capabilities: {} },
    );
  }

  async connect(config: McpServerConfig): Promise<void> {
    const transportConfig: McpTransportConfig = config.transport === 'stdio'
      ? {
          transport: 'stdio',
          command: config.command!,
          args: config.args,
          env: config.env,
        }
      : {
          transport: 'sse',
          url: config.url!,
        };

    this.transport = createTransport(transportConfig);
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.connected) {
      throw new Error(`MCP client not connected: ${this.serverName}`);
    }

    const result = await this.client.listTools();
    return result.tools.map(tool =>
      mcpToolToJouleToolDefinition(
        {
          name: `${this.serverName}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        },
        (name, args) => this.callTool(tool.name, args),
      ),
    );
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error(`MCP client not connected: ${this.serverName}`);
    }

    const result = await this.client.callTool({ name, arguments: args });

    // Extract text content from MCP response
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text);
      if (textParts.length === 1) return textParts[0];
      if (textParts.length > 1) return textParts.join('\n');
    }

    return result;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getName(): string {
    return this.serverName;
  }
}
