import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { memoryPutTool, memoryGetTool } from '../src/builtin/memory.js';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MEMORY_DIR = join(process.cwd(), '.joule');
const MEMORY_FILE = join(MEMORY_DIR, 'memory.json');

describe('Memory Tools', () => {
  beforeEach(() => {
    // Clean up memory file before each test
    if (existsSync(MEMORY_FILE)) {
      rmSync(MEMORY_FILE);
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(MEMORY_FILE)) {
      rmSync(MEMORY_FILE);
    }
  });

  it('memory_put stores a value and returns stored: true', async () => {
    const result = await memoryPutTool.execute({ key: 'testKey', value: 'hello' }) as { key: string; stored: boolean; previousValue?: unknown };
    expect(result.key).toBe('testKey');
    expect(result.stored).toBe(true);
    expect(result.previousValue).toBeUndefined();
  });

  it('memory_get retrieves a stored value', async () => {
    await memoryPutTool.execute({ key: 'color', value: 'blue' });
    const result = await memoryGetTool.execute({ key: 'color' }) as { key: string; found: boolean; value?: unknown };
    expect(result.key).toBe('color');
    expect(result.found).toBe(true);
    expect(result.value).toBe('blue');
  });

  it('memory_get returns found: false for missing key', async () => {
    const result = await memoryGetTool.execute({ key: 'nonexistent' }) as { key: string; found: boolean; value?: unknown };
    expect(result.key).toBe('nonexistent');
    expect(result.found).toBe(false);
    expect(result.value).toBeUndefined();
  });

  it('memory_put returns previousValue on overwrite', async () => {
    await memoryPutTool.execute({ key: 'count', value: 1 });
    const result = await memoryPutTool.execute({ key: 'count', value: 2 }) as { key: string; stored: boolean; previousValue?: unknown };
    expect(result.stored).toBe(true);
    expect(result.previousValue).toBe(1);

    // Verify the new value
    const getResult = await memoryGetTool.execute({ key: 'count' }) as { key: string; found: boolean; value?: unknown };
    expect(getResult.value).toBe(2);
  });
});
