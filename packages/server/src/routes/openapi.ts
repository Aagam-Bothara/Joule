import { Hono } from 'hono';
import type { Joule } from '@joule/core';

/**
 * Extract a JSON Schema-like structure from a Zod schema.
 * This is a best-effort conversion — handles the common types (object, string,
 * number, boolean, array, optional, enum) without pulling in zod-to-json-schema.
 */
function zodToJsonSchema(schema: any): Record<string, unknown> {
  if (!schema || !schema._def) return { type: 'object' };

  const def = schema._def;
  const typeName: string = def.typeName ?? '';

  switch (typeName) {
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (shape) {
        for (const [key, val] of Object.entries(shape)) {
          properties[key] = zodToJsonSchema(val);
          // If it's not optional/nullable, mark as required
          const valDef = (val as any)?._def;
          if (valDef?.typeName !== 'ZodOptional' && valDef?.typeName !== 'ZodNullable') {
            required.push(key);
          }
        }
      }

      const result: Record<string, unknown> = { type: 'object', properties };
      if (required.length > 0) result.required = required;
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodString': {
      const result: Record<string, unknown> = { type: 'string' };
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodNumber': {
      const result: Record<string, unknown> = { type: 'number' };
      if (def.description) result.description = def.description;
      return result;
    }

    case 'ZodBoolean':
      return { type: 'boolean', ...(def.description ? { description: def.description } : {}) };

    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type), ...(def.description ? { description: def.description } : {}) };

    case 'ZodEnum':
      return { type: 'string', enum: def.values, ...(def.description ? { description: def.description } : {}) };

    case 'ZodLiteral':
      return { type: typeof def.value, enum: [def.value] };

    case 'ZodOptional':
    case 'ZodNullable':
      return zodToJsonSchema(def.innerType);

    case 'ZodDefault':
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue?.() };

    case 'ZodUnion':
      return { oneOf: (def.options ?? []).map((o: any) => zodToJsonSchema(o)) };

    case 'ZodRecord':
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) };

    default:
      return { type: 'object' };
  }
}

/**
 * Generate an OpenAPI 3.1 spec from registered Joule tools.
 * Each tool becomes a POST endpoint under /tools/{toolName}/invoke.
 */
function generateOpenApiSpec(joule: Joule): Record<string, unknown> {
  const tools = joule.tools.list();
  const paths: Record<string, unknown> = {};

  // Task endpoints
  paths['/tasks'] = {
    post: {
      summary: 'Submit a task',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { description: { type: 'string' }, budget: { type: 'string', enum: ['low', 'medium', 'high', 'unlimited'] } }, required: ['description'] } } } },
      responses: { '200': { description: 'Task result' } },
    },
    get: {
      summary: 'List all tasks',
      responses: { '200': { description: 'List of tasks' } },
    },
  };
  paths['/tasks/{id}'] = {
    get: {
      summary: 'Get task result',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Task result' } },
    },
  };
  paths['/health'] = {
    get: {
      summary: 'Health check',
      responses: { '200': { description: 'Server status' } },
    },
  };

  // Tool schemas
  const toolSchemas: Record<string, unknown> = {};

  for (const tool of tools) {
    const toolPath = `/tools/${tool.name}/invoke`;
    let inputSchema: Record<string, unknown> = { type: 'object' };
    let outputSchema: Record<string, unknown> = { type: 'object' };

    try { inputSchema = zodToJsonSchema(tool.inputSchema); } catch { /* use default */ }
    try { outputSchema = zodToJsonSchema(tool.outputSchema); } catch { /* use default */ }

    paths[toolPath] = {
      post: {
        summary: tool.description,
        tags: tool.tags ?? ['tools'],
        requestBody: {
          content: { 'application/json': { schema: inputSchema } },
        },
        responses: {
          '200': {
            description: 'Tool execution result',
            content: { 'application/json': { schema: outputSchema } },
          },
        },
      },
    };

    toolSchemas[tool.name] = { input: inputSchema, output: outputSchema };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Joule API',
      version: '0.5.0',
      description: 'Energy-aware AI agent runtime API. Auto-generated from tool schemas.',
    },
    servers: [
      { url: `http://127.0.0.1:${joule.config.get('server').port}`, description: 'Local server' },
    ],
    paths,
    components: {
      schemas: toolSchemas,
    },
  };
}

export function openApiRoutes(joule: Joule) {
  const router = new Hono();

  router.get('/', (c) => {
    const spec = generateOpenApiSpec(joule);
    return c.json(spec);
  });

  return router;
}
