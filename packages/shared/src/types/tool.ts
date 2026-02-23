import type { ZodType } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolDefinition<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  execute: (input: TInput) => Promise<TOutput>;
  timeoutMs?: number;
  tags?: string[];
  requiresConfirmation?: boolean;
}

export interface ToolInvocation {
  toolName: string;
  input: unknown;
  timeoutMs?: number;
}

export interface ToolResult {
  toolName: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}
