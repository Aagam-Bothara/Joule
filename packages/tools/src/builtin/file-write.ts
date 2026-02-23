import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDefinition } from '@joule/shared';

// Preprocess to normalize common LLM aliases for the path field
const inputSchema = z.preprocess(
  (raw: unknown) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (!obj.path) {
        // Accept common aliases LLMs use instead of 'path'
        obj.path = obj.filepath ?? obj.filePath ?? obj.file_path ?? obj.filename;
      }
    }
    return raw;
  },
  z.object({
    path: z.string().describe('Absolute file path to write to (e.g. "C:/Users/name/Desktop/file.txt")'),
    content: z.string().describe('Text content to write into the file'),
    createDirs: z.boolean().default(true).describe('Create parent directories if needed'),
  }),
);

const outputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number(),
});

export const fileWriteTool: ToolDefinition = {
  name: 'file_write',
  description: 'Write text content to a file at the given path. Arguments: path (string, required — absolute file path), content (string, required — text to write)',
  inputSchema,
  outputSchema,
  tags: ['filesystem'],
  requiresConfirmation: true,
  async execute(input) {
    const parsed = input as z.infer<typeof inputSchema>;
    if (parsed.createDirs) {
      await mkdir(dirname(parsed.path), { recursive: true });
    }
    const buffer = Buffer.from(parsed.content, 'utf-8');
    await writeFile(parsed.path, buffer);
    return { path: parsed.path, bytesWritten: buffer.length };
  },
};
