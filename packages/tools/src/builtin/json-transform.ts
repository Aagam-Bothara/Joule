import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';

const inputSchema = z.object({
  json: z.string().describe('JSON string to transform'),
  operation: z.enum(['parse', 'stringify', 'pick', 'keys', 'values', 'flatten'])
    .describe('Transform operation'),
  fields: z.array(z.string()).optional().describe('Fields to pick (for "pick" operation)'),
  indent: z.number().default(2).describe('Indentation for stringify'),
});

const outputSchema = z.object({
  result: z.string(),
  type: z.string(),
});

export const jsonTransformTool: ToolDefinition = {
  name: 'json_transform',
  description: 'Parse, transform, and extract data from JSON',
  inputSchema,
  outputSchema,
  tags: ['data'],
  async execute(input) {
    const parsed = input as z.infer<typeof inputSchema>;
    const data = JSON.parse(parsed.json);

    switch (parsed.operation) {
      case 'parse':
        return { result: JSON.stringify(data, null, parsed.indent), type: typeof data };

      case 'stringify':
        return { result: JSON.stringify(data, null, parsed.indent), type: 'string' };

      case 'pick': {
        if (!parsed.fields?.length) {
          throw new Error('Fields required for pick operation');
        }
        const picked: Record<string, unknown> = {};
        for (const field of parsed.fields) {
          if (field in data) {
            picked[field] = data[field];
          }
        }
        return { result: JSON.stringify(picked, null, parsed.indent), type: 'object' };
      }

      case 'keys':
        return { result: JSON.stringify(Object.keys(data)), type: 'array' };

      case 'values':
        return { result: JSON.stringify(Object.values(data)), type: 'array' };

      case 'flatten': {
        const flat = flattenObject(data);
        return { result: JSON.stringify(flat, null, parsed.indent), type: 'object' };
      }

      default:
        throw new Error(`Unknown operation: ${parsed.operation}`);
    }
  },
};

function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}
