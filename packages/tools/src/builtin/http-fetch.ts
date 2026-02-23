import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';

const inputSchema = z.object({
  url: z.string().url().describe('URL to fetch'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().default(10_000),
});

const outputSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  headers: z.record(z.string()),
  body: z.string(),
  truncated: z.boolean(),
});

export const httpFetchTool: ToolDefinition = {
  name: 'http_fetch',
  description: 'Make an HTTP request and return the response',
  inputSchema,
  outputSchema,
  tags: ['network'],
  async execute(input) {
    const parsed = input as z.infer<typeof inputSchema>;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), parsed.timeoutMs);

    try {
      const response = await fetch(parsed.url, {
        method: parsed.method,
        headers: parsed.headers,
        body: parsed.body,
        signal: controller.signal,
      });

      const maxBody = 100_000;
      const text = await response.text();
      const truncated = text.length > maxBody;

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: truncated ? text.slice(0, maxBody) : text,
        truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
