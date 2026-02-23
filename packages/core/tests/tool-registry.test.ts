import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../src/tool-registry.js';
import { ToolNotFoundError } from '@joule/shared';

const echoTool = {
  name: 'echo',
  description: 'Echo input back',
  inputSchema: z.object({ message: z.string() }),
  outputSchema: z.object({ echoed: z.string() }),
  async execute(input: { message: string }) {
    return { echoed: input.message };
  },
};

const failTool = {
  name: 'fail',
  description: 'Always fails',
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  async execute() {
    throw new Error('intentional failure');
  },
};

describe('ToolRegistry', () => {
  it('registers and lists tools', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.list()).toHaveLength(1);
    expect(registry.has('echo')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('invokes a tool successfully', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const result = await registry.invoke({
      toolName: 'echo',
      input: { message: 'hello' },
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echoed: 'hello' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns error result on tool failure', async () => {
    const registry = new ToolRegistry();
    registry.register(failTool);

    const result = await registry.invoke({
      toolName: 'fail',
      input: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('intentional failure');
  });

  it('throws ToolNotFoundError for unknown tool', async () => {
    const registry = new ToolRegistry();
    await expect(
      registry.invoke({ toolName: 'nonexistent', input: {} }),
    ).rejects.toThrow(ToolNotFoundError);
  });

  it('validates input against schema', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);

    const result = await registry.invoke({
      toolName: 'echo',
      input: { wrong: 'field' },
    });

    expect(result.success).toBe(false);
  });

  it('unregisters tools', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(registry.has('echo')).toBe(true);
    registry.unregister('echo');
    expect(registry.has('echo')).toBe(false);
  });

  it('returns tool descriptions with argument info', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const descriptions = registry.getToolDescriptions();
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0].name).toBe('echo');
    expect(descriptions[0].description).toContain('Echo input back');
    expect(descriptions[0].description).toContain('Args:');
    expect(descriptions[0].description).toContain('message');
  });
});
