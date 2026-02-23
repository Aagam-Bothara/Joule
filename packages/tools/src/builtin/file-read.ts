import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from '@joule/shared';

const inputSchema = z.object({
  path: z.string().describe('File path to read'),
  encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
  maxBytes: z.number().default(100_000).describe('Max bytes to read'),
});

const outputSchema = z.object({
  content: z.string(),
  sizeBytes: z.number(),
  truncated: z.boolean(),
});

export const fileReadTool: ToolDefinition = {
  name: 'file_read',
  description: 'Read the contents of a file',
  inputSchema,
  outputSchema,
  tags: ['filesystem'],
  async execute(input) {
    const parsed = input as z.infer<typeof inputSchema>;
    const buffer = await readFile(parsed.path);
    const truncated = buffer.length > parsed.maxBytes;
    const content = buffer.subarray(0, parsed.maxBytes).toString(parsed.encoding as BufferEncoding);
    return { content, sizeBytes: buffer.length, truncated };
  },
};
