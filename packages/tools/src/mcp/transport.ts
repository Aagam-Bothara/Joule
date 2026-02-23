import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface StdioTransportConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SseTransportConfig {
  transport: 'sse';
  url: string;
}

export type McpTransportConfig = StdioTransportConfig | SseTransportConfig;

export function createTransport(config: McpTransportConfig): Transport {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    });
  }

  if (config.transport === 'sse') {
    return new SSEClientTransport(new URL(config.url));
  }

  throw new Error(`Unknown MCP transport: ${(config as any).transport}`);
}
