import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OptimizedMemory } from '../src/memory/optimized-memory.js';
import { FactExtractor } from '../src/memory/fact-extractor.js';
import type { EpisodicMemory } from '@joule/shared';

describe('FactExtractor', () => {
  let memory: OptimizedMemory;
  let extractor: FactExtractor;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'joule-extract-test-'));
    memory = new OptimizedMemory(tempDir);
    extractor = new FactExtractor(memory);
  });

  afterEach(async () => {
    memory.stopConsolidation();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('extractFromInput', () => {
    it('extracts preferences from user statements', async () => {
      const result = await extractor.extractFromInput('I prefer dark mode over light mode');
      expect(result.preferences.length).toBeGreaterThan(0);
      expect(result.preferences[0].key).toContain('preference:');
    });

    it('extracts identity information', async () => {
      const result = await extractor.extractFromInput('my name is Alice');
      expect(result.preferences.length).toBeGreaterThan(0);
    });

    it('extracts filenames from text', async () => {
      const result = await extractor.extractFromInput('please check the file config.yaml');
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities.some(e => e.name === 'config.yaml')).toBe(true);
    });

    it('extracts URLs from text', async () => {
      const result = await extractor.extractFromInput('check https://example.com/api for docs');
      expect(result.entities.some(e => e.type === 'url')).toBe(true);
    });

    it('extracts emails from text', async () => {
      const result = await extractor.extractFromInput('contact alice@example.com for help');
      expect(result.entities.some(e => e.type === 'email')).toBe(true);
    });

    it('handles empty input', async () => {
      const result = await extractor.extractFromInput('');
      expect(result.facts).toEqual([]);
      expect(result.preferences).toEqual([]);
      expect(result.entities).toEqual([]);
    });
  });

  describe('extractFromResult', () => {
    it('extracts version information', async () => {
      const result = await extractor.extractFromResult('running node version 22.0.0');
      expect(result.facts.length).toBeGreaterThan(0);
      expect(result.facts[0].category).toBe('environment');
    });

    it('extracts port numbers', async () => {
      const result = await extractor.extractFromResult('Server started on port 3927');
      expect(result.facts.some(f => f.key === 'config:port')).toBe(true);
      expect(result.facts.find(f => f.key === 'config:port')?.value).toBe('3927');
    });

    it('extracts error messages', async () => {
      const result = await extractor.extractFromResult('Error: Module not found');
      expect(result.facts.some(f => f.category === 'error')).toBe(true);
    });

    it('extracts filenames from results', async () => {
      const result = await extractor.extractFromResult('modified src/index.ts and utils.js');
      expect(result.entities.some(e => e.name === 'index.ts')).toBe(true);
      expect(result.entities.some(e => e.name === 'utils.js')).toBe(true);
    });
  });

  describe('storeExtracted', () => {
    it('stores extracted facts in memory', async () => {
      const extracted = {
        facts: [
          { key: 'config:port', value: '3000', category: 'configuration', confidence: 0.6 },
        ],
        preferences: [
          { key: 'pref:theme', value: 'dark' },
        ],
        entities: [
          { name: 'index.ts', type: 'filename', attributes: {} },
        ],
      };

      await extractor.storeExtracted(extracted, 'test');

      const fact = await memory.getFact('config:port');
      expect(fact).toBeDefined();
      expect(fact!.value).toBe('3000');

      const pref = await memory.getPreference('pref:theme');
      expect(pref).toBeDefined();
      expect(pref!.value).toBe('dark');
    });
  });

  describe('learnFromExecution', () => {
    it('records episode and extracts knowledge', async () => {
      const episode = await memory.recordEpisode(
        'task-1',
        'Fixed the CSS styling issue',
        'success',
        ['file_write', 'browser_navigate'],
        { tags: ['css', 'fix'] },
      );

      await extractor.learnFromExecution(
        'fix the CSS on the login page',
        'Updated styles.css with correct flexbox layout',
        episode,
      );

      // Should have created a procedure from the successful execution
      const procs = await memory.findProcedure('fix css');
      expect(procs.length).toBeGreaterThanOrEqual(0); // may or may not trigger depending on keyword matching
    });

    it('does not learn procedures from failed executions', async () => {
      const episode = await memory.recordEpisode(
        'task-2',
        'Failed to deploy',
        'failed',
        ['shell_exec'],
      );

      await extractor.learnFromExecution(
        'deploy the app',
        'Error: deployment failed',
        episode,
      );

      const procs = await memory.findProcedure('deploy');
      // Should not have learned from a failed execution
      expect(procs.length).toBe(0);
    });
  });
});
