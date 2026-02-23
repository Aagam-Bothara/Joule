import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { OptimizedMemory } from '../src/memory/optimized-memory.js';

describe('Failure Pattern Learning', () => {
  let memory: OptimizedMemory;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'joule-fail-'));
    memory = new OptimizedMemory(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should store a new failure pattern', async () => {
    const pattern = await memory.storeFailurePattern({
      toolName: 'browser_click',
      errorSignature: 'Element not found: .submit-btn',
      context: 'Trying to submit a form',
    });

    expect(pattern.id).toBeTruthy();
    expect(pattern.toolName).toBe('browser_click');
    expect(pattern.errorSignature).toBe('Element not found: .submit-btn');
    expect(pattern.occurrences).toBe(1);
    expect(pattern.lastSeen).toBeTruthy();
  });

  it('should deduplicate patterns by toolName + errorSignature', async () => {
    await memory.storeFailurePattern({
      toolName: 'browser_click',
      errorSignature: 'Element not found',
      context: 'Context A',
    });

    const updated = await memory.storeFailurePattern({
      toolName: 'browser_click',
      errorSignature: 'Element not found',
      context: 'Context B — longer context',
    });

    expect(updated.occurrences).toBe(2);
    // Context is updated to the longer one
    expect(updated.context).toBe('Context B — longer context');

    const all = await memory.getFailurePatterns();
    expect(all).toHaveLength(1);
  });

  it('should store resolution when recovery succeeds', async () => {
    await memory.storeFailurePattern({
      toolName: 'file_read',
      errorSignature: 'ENOENT: no such file',
      context: 'Reading config file',
    });

    const updated = await memory.storeFailurePattern({
      toolName: 'file_read',
      errorSignature: 'ENOENT: no such file',
      context: 'Reading config file',
      resolution: 'Created file with default config first',
    });

    expect(updated.resolution).toBe('Created file with default config first');
  });

  it('should filter patterns by tool name', async () => {
    await memory.storeFailurePattern({
      toolName: 'browser_click',
      errorSignature: 'Timeout',
      context: 'Clicking button',
    });
    await memory.storeFailurePattern({
      toolName: 'file_read',
      errorSignature: 'ENOENT',
      context: 'Reading file',
    });

    const browserPatterns = await memory.getFailurePatterns('browser_click');
    expect(browserPatterns).toHaveLength(1);
    expect(browserPatterns[0].toolName).toBe('browser_click');

    const allPatterns = await memory.getFailurePatterns();
    expect(allPatterns).toHaveLength(2);
  });

  it('should sort patterns by occurrence count', async () => {
    await memory.storeFailurePattern({ toolName: 'tool_a', errorSignature: 'err_a', context: '' });
    await memory.storeFailurePattern({ toolName: 'tool_b', errorSignature: 'err_b', context: '' });
    await memory.storeFailurePattern({ toolName: 'tool_b', errorSignature: 'err_b', context: '' });
    await memory.storeFailurePattern({ toolName: 'tool_b', errorSignature: 'err_b', context: '' });

    const patterns = await memory.getFailurePatterns();
    expect(patterns[0].toolName).toBe('tool_b');
    expect(patterns[0].occurrences).toBe(3);
  });

  it('should generate planner context from failure patterns', async () => {
    await memory.storeFailurePattern({
      toolName: 'browser_click',
      errorSignature: 'Element not interactable',
      context: 'Clicking submit',
      resolution: 'Used browser_wait_and_click instead',
    });
    await memory.storeFailurePattern({
      toolName: 'file_read',
      errorSignature: 'ENOENT',
      context: 'Reading config',
    });

    const context = await memory.getFailurePatternsForPlanning(['browser_click', 'file_read']);
    expect(context).toContain('browser_click');
    expect(context).toContain('Element not interactable');
    expect(context).toContain('resolved: Used browser_wait_and_click instead');
    expect(context).toContain('file_read');
    expect(context).toContain('ENOENT');
  });

  it('should return empty string when no patterns match requested tools', async () => {
    await memory.storeFailurePattern({
      toolName: 'tool_x',
      errorSignature: 'err',
      context: '',
    });

    const context = await memory.getFailurePatternsForPlanning(['browser_click', 'file_read']);
    expect(context).toBe('');
  });

  it('should persist patterns to disk', async () => {
    await memory.storeFailurePattern({
      toolName: 'test_tool',
      errorSignature: 'test_error',
      context: 'persistence test',
    });

    // Create a new memory instance reading from the same directory
    const memory2 = new OptimizedMemory(tempDir);
    const patterns = await memory2.getFailurePatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].toolName).toBe('test_tool');
  });
});
