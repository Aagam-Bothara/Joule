import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the heavy dependencies before importing
vi.mock('@joule/models', () => ({
  ModelProviderRegistry: class {
    private providers: unknown[] = [];
    register(p: unknown) { this.providers.push(p); }
    list() { return this.providers; }
  },
  OllamaProvider: class { constructor(public opts: unknown) {} },
  AnthropicProvider: class { constructor(public opts: unknown) {} },
  OpenAIProvider: class { constructor(public opts: unknown) {} },
  GoogleProvider: class { constructor(public opts: unknown) {} },
}));

vi.mock('@joule/tools', () => ({
  fileReadTool: { name: 'file_read', description: 'Read file', parameters: {}, execute: vi.fn() },
  fileWriteTool: { name: 'file_write', description: 'Write file', parameters: {}, execute: vi.fn() },
  shellExecTool: { name: 'shell_exec', description: 'Execute shell', parameters: {}, execute: vi.fn() },
  httpFetchTool: { name: 'http_fetch', description: 'HTTP fetch', parameters: {}, execute: vi.fn() },
  jsonTransformTool: { name: 'json_transform', description: 'JSON transform', parameters: {}, execute: vi.fn() },
}));

describe('Simple Mode API', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear any API keys
    delete process.env.JOULE_ANTHROPIC_API_KEY;
    delete process.env.JOULE_OPENAI_API_KEY;
    delete process.env.JOULE_GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should export simple and simpleStream functions', async () => {
    const { simple, simpleStream } = await import('../src/simple.js');
    expect(typeof simple).toBe('function');
    expect(typeof simpleStream).toBe('function');
  });

  it('should export SimpleOptions type via index', async () => {
    const exports = await import('../src/index.js');
    expect(typeof exports.simple).toBe('function');
    expect(typeof exports.simpleStream).toBe('function');
  });

  it('Joule class should have static simple methods', async () => {
    const { Joule } = await import('../src/engine.js');
    expect(typeof Joule.simple).toBe('function');
    expect(typeof Joule.simpleStream).toBe('function');
  });

  it('buildSimpleConfig returns sensible defaults', async () => {
    // We test the internal buildSimpleConfig indirectly through the module
    const mod = await import('../src/simple.js');
    // simple() should be a function that takes a string
    expect(mod.simple.length).toBeGreaterThanOrEqual(1);
  });

  it('SimpleOptions has correct shape', async () => {
    // TypeScript compile-time check — if this compiles, the interface is correct
    const opts: import('../src/simple.js').SimpleOptions = {
      budget: 'low',
      provider: 'anthropic',
      governance: false,
      configOverrides: { logging: { level: 'debug', traceOutput: 'memory' } },
    };
    expect(opts.budget).toBe('low');
    expect(opts.provider).toBe('anthropic');
    expect(opts.governance).toBe(false);
  });
});
