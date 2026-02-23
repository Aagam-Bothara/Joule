import { z, type ZodType } from 'zod';
import type { ToolDefinition } from '@joule/shared';

/**
 * Converts a JSON Schema object to a Zod schema.
 * Handles the common types used by MCP tools.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): ZodType {
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }

  const type = schema.type as string;

  switch (type) {
    case 'string': {
      let s = z.string();
      if (schema.enum) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      if (schema.minLength) s = s.min(schema.minLength as number);
      if (schema.maxLength) s = s.max(schema.maxLength as number);
      return s;
    }
    case 'number':
    case 'integer': {
      let n = type === 'integer' ? z.number().int() : z.number();
      if (schema.minimum !== undefined) n = n.min(schema.minimum as number);
      if (schema.maximum !== undefined) n = n.max(schema.maximum as number);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = schema.items as Record<string, unknown> | undefined;
      return z.array(items ? jsonSchemaToZod(items) : z.any());
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      const required = (schema.required as string[]) ?? [];

      if (!properties) {
        return z.record(z.any());
      }

      const shape: Record<string, ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const fieldSchema = jsonSchemaToZod(propSchema);
        shape[key] = required.includes(key) ? fieldSchema : fieldSchema.optional();
      }

      return z.object(shape).passthrough();
    }
    default:
      return z.any();
  }
}

/**
 * Converts an MCP tool definition to a Joule ToolDefinition.
 */
export function mcpToolToJouleToolDefinition(
  mcpTool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  },
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): ToolDefinition {
  const inputSchema = mcpTool.inputSchema
    ? jsonSchemaToZod(mcpTool.inputSchema)
    : z.object({}).passthrough();

  return {
    name: mcpTool.name,
    description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
    inputSchema,
    outputSchema: z.any(),
    tags: ['mcp'],
    execute: async (input: unknown) => {
      return callTool(mcpTool.name, input as Record<string, unknown>);
    },
  };
}
