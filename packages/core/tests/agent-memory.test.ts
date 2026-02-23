import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentMemory } from '../src/agent-memory.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('AgentMemory', () => {
  let memory: AgentMemory;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `joule-memory-test-${Date.now()}`);
    memory = new AgentMemory(tempDir);
  });

  afterEach(async () => {
    memory.optimized.stopConsolidation();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // --- Facts ---

  it('stores and retrieves a fact', async () => {
    const fact = await memory.storeFact('project-lang', 'TypeScript', 'tech', 'user');
    expect(fact.key).toBe('project-lang');
    expect(fact.value).toBe('TypeScript');
    expect(fact.category).toBe('tech');
    expect(fact.confidence).toBe(0.5);

    const retrieved = await memory.getFact('project-lang');
    expect(retrieved).toBeDefined();
    expect(retrieved!.value).toBe('TypeScript');
    expect(retrieved!.temporal.accessCount).toBe(1);
  });

  it('updates existing fact and increases confidence', async () => {
    await memory.storeFact('framework', 'React', 'tech', 'agent');
    const updated = await memory.storeFact('framework', 'Next.js', 'tech', 'agent');
    expect(updated.value).toBe('Next.js');
    // Superseding fact gets small confidence boost
    expect(updated.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('searches facts by category', async () => {
    await memory.storeFact('lang', 'TS', 'tech', 'user');
    await memory.storeFact('color', 'blue', 'pref', 'user');
    await memory.storeFact('db', 'postgres', 'tech', 'user');

    const techFacts = await memory.searchFacts({ category: 'tech' });
    expect(techFacts).toHaveLength(2);
    expect(techFacts.map(f => f.key)).toContain('lang');
    expect(techFacts.map(f => f.key)).toContain('db');
  });

  it('updates fact confidence', async () => {
    const fact = await memory.storeFact('test-key', 'value', 'test', 'agent');
    await memory.updateFactConfidence(fact.id, 0.3);
    const updated = await memory.getFact('test-key');
    expect(updated!.confidence).toBeCloseTo(0.8, 1);
  });

  // --- Episodes ---

  it('records and retrieves episodes', async () => {
    await memory.recordEpisode('task-1', 'Listed files', 'success', ['file_read'], 0.001, 0.0005, ['filesystem']);
    await memory.recordEpisode('task-2', 'Ran tests', 'failed', ['shell_exec'], 0.002, 0.001, ['testing']);

    const episodes = await memory.getRecentEpisodes(10);
    expect(episodes).toHaveLength(2);
    // Most recent first
    expect(episodes[0].taskId).toBe('task-2');
  });

  it('searches episodes by tags', async () => {
    await memory.recordEpisode('t1', 'Build', 'success', [], 0, 0, ['build']);
    await memory.recordEpisode('t2', 'Test', 'success', [], 0, 0, ['test']);
    await memory.recordEpisode('t3', 'Deploy', 'success', [], 0, 0, ['deploy']);

    const testEps = await memory.searchEpisodes(['test']);
    expect(testEps).toHaveLength(1);
    expect(testEps[0].summary).toBe('Test');
  });

  // --- Preferences ---

  it('sets and gets preferences', async () => {
    const pref = await memory.setPreference('output-format', 'json', 'user-request');
    expect(pref.key).toBe('output-format');
    expect(pref.value).toBe('json');
    expect(pref.confidence).toBe(0.5);

    const retrieved = await memory.getPreference('output-format');
    expect(retrieved).toBeDefined();
    expect(retrieved!.value).toBe('json');
  });

  it('updates existing preference', async () => {
    await memory.setPreference('verbosity', 'low', 'default');
    const updated = await memory.setPreference('verbosity', 'high', 'user-feedback');
    expect(updated.value).toBe('high');
    expect(updated.confidence).toBe(0.6);
  });

  it('lists all preferences', async () => {
    await memory.setPreference('a', 1, 'test');
    await memory.setPreference('b', 2, 'test');
    const all = await memory.getAllPreferences();
    expect(all).toHaveLength(2);
  });

  // --- Cross-layer recall ---

  it('recalls across all layers', async () => {
    await memory.storeFact('project', 'Joule', 'meta', 'user');
    await memory.recordEpisode('t1', 'Init', 'success', [], 0, 0, ['init']);
    await memory.setPreference('style', 'concise', 'user');

    const results = await memory.recall({});
    // At least facts + episodes + preferences (may also include procedural)
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.map(r => r.layer)).toContain('facts');
    expect(results.map(r => r.layer)).toContain('episodes');
    expect(results.map(r => r.layer)).toContain('preferences');
  });

  it('recalls from specific layer', async () => {
    await memory.storeFact('key', 'val', 'cat', 'src');
    await memory.setPreference('pref', 'val', 'src');

    const results = await memory.recall({ layer: 'facts' as any });
    expect(results).toHaveLength(1);
    expect(results[0].layer).toBe('facts');
  });

  // --- Persistence ---

  it('persists data to files and reloads', async () => {
    await memory.storeFact('persist-test', 'hello', 'test', 'test');
    await memory.recordEpisode('ep-1', 'Persisted', 'success', [], 0, 0);

    // Create a new memory instance reading same directory
    const memory2 = new AgentMemory(tempDir);
    const fact = await memory2.getFact('persist-test');
    expect(fact).toBeDefined();
    expect(fact!.value).toBe('hello');

    const episodes = await memory2.getRecentEpisodes(10);
    expect(episodes).toHaveLength(1);
  });

  // --- Pruning ---

  it('prunes by maxItems', async () => {
    for (let i = 0; i < 5; i++) {
      await memory.storeFact(`key-${i}`, `val-${i}`, 'test', 'test');
    }
    for (let i = 0; i < 5; i++) {
      await memory.recordEpisode(`t-${i}`, `Summary ${i}`, 'success', [], 0, 0);
    }

    const result = await memory.prune(undefined, 3);
    expect(result.factsRemoved).toBe(2);
    expect(result.episodesRemoved).toBe(2);
  });
});
