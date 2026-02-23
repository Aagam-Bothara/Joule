import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZod, mcpToolToJouleToolDefinition } from '../src/mcp/schema-bridge.js';

describe('JSON Schema to Zod Bridge', () => {
  it('converts string type', () => {
    const schema = jsonSchemaToZod({ type: 'string' });
    expect(schema.parse('hello')).toBe('hello');
    expect(() => schema.parse(42)).toThrow();
  });

  it('converts string enum', () => {
    const schema = jsonSchemaToZod({ type: 'string', enum: ['a', 'b', 'c'] });
    expect(schema.parse('a')).toBe('a');
    expect(() => schema.parse('d')).toThrow();
  });

  it('converts number type with constraints', () => {
    const schema = jsonSchemaToZod({ type: 'number', minimum: 0, maximum: 100 });
    expect(schema.parse(50)).toBe(50);
    expect(() => schema.parse(-1)).toThrow();
    expect(() => schema.parse(101)).toThrow();
  });

  it('converts integer type', () => {
    const schema = jsonSchemaToZod({ type: 'integer' });
    expect(schema.parse(42)).toBe(42);
    expect(() => schema.parse(3.14)).toThrow();
  });

  it('converts boolean type', () => {
    const schema = jsonSchemaToZod({ type: 'boolean' });
    expect(schema.parse(true)).toBe(true);
    expect(() => schema.parse('yes')).toThrow();
  });

  it('converts array type', () => {
    const schema = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => schema.parse([1, 2])).toThrow();
  });

  it('converts object type with properties', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
      },
      required: ['name'],
    });

    expect(schema.parse({ name: 'Alice', age: 30 })).toEqual({ name: 'Alice', age: 30 });
    expect(schema.parse({ name: 'Bob' })).toEqual({ name: 'Bob' });
    expect(() => schema.parse({ age: 30 })).toThrow(); // name is required
  });

  it('handles unknown/null schema gracefully', () => {
    const schema = jsonSchemaToZod({});
    expect(schema.parse('anything')).toBe('anything');
    expect(schema.parse(42)).toBe(42);
  });
});

describe('MCP Tool to Joule Tool Definition', () => {
  it('creates a valid tool definition', async () => {
    const callTool = async (_name: string, _args: Record<string, unknown>) => ({ result: 'ok' });

    const tool = mcpToolToJouleToolDefinition(
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
      callTool,
    );

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('A test tool');
    expect(tool.tags).toContain('mcp');

    const result = await tool.execute({ query: 'test' });
    expect(result).toEqual({ result: 'ok' });
  });

  it('provides default description when none given', () => {
    const tool = mcpToolToJouleToolDefinition(
      { name: 'my_tool' },
      async () => ({}),
    );
    expect(tool.description).toBe('MCP tool: my_tool');
  });
});
