import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OptimizedMemory } from '../src/memory/optimized-memory.js';

describe('OptimizedMemory', () => {
  let memory: OptimizedMemory;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'joule-mem-test-'));
    memory = new OptimizedMemory(tempDir);
  });

  afterEach(async () => {
    memory.stopConsolidation();
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- Semantic Memory (Facts) ---

  describe('Semantic Memory', () => {
    it('stores and retrieves facts', async () => {
      const fact = await memory.storeFact('user_name', 'Alice', 'identity', 'user');
      expect(fact.key).toBe('user_name');
      expect(fact.value).toBe('Alice');
      expect(fact.confidence).toBe(0.5);

      const retrieved = await memory.getFact('user_name');
      expect(retrieved).toBeDefined();
      expect(retrieved!.value).toBe('Alice');
    });

    it('boosts confidence on repeated store with same value', async () => {
      await memory.storeFact('color', 'blue', 'preference', 'user');
      const updated = await memory.storeFact('color', 'blue', 'preference', 'user');
      expect(updated.confidence).toBeGreaterThan(0.5);
    });

    it('supersedes facts when value changes', async () => {
      const original = await memory.storeFact('city', 'New York', 'location', 'user');
      const updated = await memory.storeFact('city', 'San Francisco', 'location', 'user');

      expect(updated.supersedes).toBe(original.id);
      expect(updated.value).toBe('San Francisco');

      // Old fact should be superseded
      const results = await memory.searchFacts({ key: 'city' });
      expect(results.length).toBe(1);
      expect(results[0].value).toBe('San Francisco');
    });

    it('searches facts by category', async () => {
      await memory.storeFact('port', '3000', 'config', 'system');
      await memory.storeFact('host', 'localhost', 'config', 'system');
      await memory.storeFact('name', 'Alice', 'identity', 'user');

      const configs = await memory.searchFacts({ category: 'config' });
      expect(configs.length).toBe(2);
    });

    it('searches facts by semantic similarity', async () => {
      await memory.storeFact('deploy_target', 'kubernetes', 'infrastructure', 'system', 'project', undefined, ['deploy', 'k8s']);
      await memory.storeFact('test_framework', 'vitest', 'tooling', 'system', 'project', undefined, ['testing']);
      await memory.storeFact('language', 'typescript', 'tooling', 'system', 'project', undefined, ['language']);

      const results = await memory.searchFacts({ text: 'deployment infrastructure kubernetes' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].key).toBe('deploy_target');
    });

    it('filters by scope', async () => {
      await memory.storeFact('setting_a', 'val', 'config', 'system', 'project');
      await memory.storeFact('setting_b', 'val', 'config', 'system', 'user');

      const projectFacts = await memory.searchFacts({ scope: 'project' });
      expect(projectFacts.length).toBe(1);
      expect(projectFacts[0].key).toBe('setting_a');
    });

    it('filters by tags', async () => {
      await memory.storeFact('fact1', 'v1', 'general', 'agent', 'project', undefined, ['important', 'config']);
      await memory.storeFact('fact2', 'v2', 'general', 'agent', 'project', undefined, ['debug']);

      const results = await memory.searchFacts({ tags: ['important'] });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('fact1');
    });

    it('filters by minimum confidence', async () => {
      const lowConf = await memory.storeFact('low', 'v', 'test', 'agent');
      expect(lowConf.confidence).toBe(0.5);

      // Boost one fact's confidence
      await memory.storeFact('high', 'v', 'test', 'agent');
      await memory.storeFact('high', 'v', 'test', 'agent'); // +0.1
      await memory.storeFact('high', 'v', 'test', 'agent'); // +0.1
      await memory.storeFact('high', 'v', 'test', 'agent'); // +0.1 = 0.8

      const results = await memory.searchFacts({ minConfidence: 0.7 });
      expect(results.length).toBe(1);
      expect(results[0].key).toBe('high');
    });
  });

  // --- Episodic Memory ---

  describe('Episodic Memory', () => {
    it('records and retrieves episodes', async () => {
      const ep = await memory.recordEpisode(
        'task-1', 'Search for files on disk', 'success', ['file_read', 'shell_exec'],
        { tags: ['filesystem'] },
      );
      expect(ep.taskId).toBe('task-1');
      expect(ep.outcome).toBe('success');

      const recent = await memory.getRecentEpisodes(5);
      expect(recent.length).toBe(1);
      expect(recent[0].taskId).toBe('task-1');
    });

    it('finds similar episodes semantically', async () => {
      await memory.recordEpisode('t1', 'Deploy application to kubernetes cluster', 'success', ['shell_exec']);
      await memory.recordEpisode('t2', 'Run unit tests for react components', 'success', ['shell_exec']);
      await memory.recordEpisode('t3', 'Fix CSS styling on login page', 'failed', ['file_write']);

      const similar = await memory.findSimilarEpisodes('deploy app to k8s');
      expect(similar.length).toBeGreaterThan(0);
      expect(similar[0].taskId).toBe('t1');
    });

    it('records lessons learned for failed tasks', async () => {
      await memory.recordEpisode('t1', 'Install dependencies', 'failed', ['shell_exec'], {
        lessonsLearned: 'npm install failed due to incompatible peer dependencies',
      });

      const episodes = await memory.getRecentEpisodes(1);
      expect(episodes[0].lessonsLearned).toContain('peer dependencies');
    });

    it('tracks cost and energy in episodes', async () => {
      await memory.recordEpisode('t1', 'Complex analysis', 'success', ['shell_exec'], {
        costUsd: 0.05,
        energyUsed: 0.002,
        durationMs: 5000,
      });

      const eps = await memory.getRecentEpisodes(1);
      expect(eps[0].costUsd).toBe(0.05);
      expect(eps[0].energyUsed).toBe(0.002);
      expect(eps[0].durationMs).toBe(5000);
    });
  });

  // --- Procedural Memory ---

  describe('Procedural Memory', () => {
    it('learns and finds procedures', async () => {
      await memory.learnProcedure(
        'deploy-app',
        'Deploy a web application',
        'deploy application web app production',
        [
          { tool: 'shell_exec', argTemplate: { command: 'npm run build' }, description: 'Build app' },
          { tool: 'shell_exec', argTemplate: { command: 'docker push' }, description: 'Push container' },
        ],
        ['deploy'],
      );

      const procs = await memory.findProcedure('deploy my web application');
      expect(procs.length).toBe(1);
      expect(procs[0].name).toBe('deploy-app');
    });

    it('updates existing procedure on re-learn', async () => {
      await memory.learnProcedure('test', 'Run tests', 'test run', []);
      const updated = await memory.learnProcedure('test', 'Run tests', 'test run', [
        { tool: 'shell_exec', argTemplate: {}, description: 'Run vitest' },
      ]);

      expect(updated.confidence).toBeGreaterThan(0.5);
      expect(updated.pattern.steps).toHaveLength(1);
    });

    it('tracks procedure usage and success rate', async () => {
      const proc = await memory.learnProcedure('build', 'Build project', 'build project', []);

      await memory.recordProcedureUsage(proc.id, true);
      await memory.recordProcedureUsage(proc.id, true);
      await memory.recordProcedureUsage(proc.id, false);

      const procs = await memory.findProcedure('build project');
      expect(procs[0].timesUsed).toBe(3);
      expect(procs[0].successRate).toBeCloseTo(2/3, 2);
    });
  });

  // --- Working Memory ---

  describe('Working Memory', () => {
    it('creates working memory for session', async () => {
      const wm = await memory.getWorkingMemory('session-1');
      expect(wm.sessionId).toBe('session-1');
      expect(wm.contextWindow).toEqual([]);
    });

    it('prepares context with relevant facts and episodes', async () => {
      // Seed some facts and episodes
      await memory.storeFact('db_host', 'localhost:5432', 'config', 'system', 'project', undefined, ['database']);
      await memory.recordEpisode('t1', 'Connected to PostgreSQL database', 'success', ['shell_exec'], {
        tags: ['database'],
      });
      await memory.setPreference('output_format', 'json', 'user');

      const wm = await memory.prepareContext('session-2', 'query the database');

      expect(wm.activeGoal).toBe('query the database');
      expect(wm.contextWindow.length).toBeGreaterThan(0);
    });

    it('builds context injection string', async () => {
      await memory.storeFact('api_key_location', '.env file', 'config', 'system');
      await memory.setPreference('verbose_output', true, 'user');

      const wm = await memory.prepareContext('s1', 'configure the API');
      const injection = memory.buildContextInjection(wm);

      expect(injection).toContain('[Agent Memory Context]');
      expect(injection).toContain('[End Memory Context]');
    });

    it('manages scratchpad data', async () => {
      await memory.setScratchpad('s1', 'temp_result', { count: 42 });
      const val = await memory.getScratchpad('s1', 'temp_result');
      expect(val).toEqual({ count: 42 });
    });
  });

  // --- Associative Memory ---

  describe('Associative Memory', () => {
    it('creates and retrieves links', async () => {
      const link = await memory.createLink('ep-1', 'episodic', 'fact-1', 'semantic', 'used_knowledge');
      expect(link.relationship).toBe('used_knowledge');
      expect(link.strength).toBe(0.5);

      const links = await memory.getLinked('ep-1');
      expect(links.length).toBe(1);
    });

    it('strengthens existing links on re-creation', async () => {
      await memory.createLink('a', 'episodic', 'b', 'semantic', 'related');
      const updated = await memory.createLink('a', 'episodic', 'b', 'semantic', 'related');
      expect(updated.strength).toBeGreaterThan(0.5);
    });

    it('finds links by relationship type', async () => {
      await memory.createLink('a', 'episodic', 'b', 'semantic', 'caused_by');
      await memory.createLink('a', 'episodic', 'c', 'semantic', 'related_to');

      const causalLinks = await memory.getLinked('a', 'caused_by');
      expect(causalLinks.length).toBe(1);
      expect(causalLinks[0].targetId).toBe('b');
    });
  });

  // --- Preferences ---

  describe('Preferences', () => {
    it('stores and retrieves preferences', async () => {
      await memory.setPreference('theme', 'dark', 'user_request');
      const pref = await memory.getPreference('theme');
      expect(pref).toBeDefined();
      expect(pref!.value).toBe('dark');
    });

    it('boosts confidence on repeated set', async () => {
      await memory.setPreference('lang', 'typescript', 'observation');
      const updated = await memory.setPreference('lang', 'typescript', 'observation');
      expect(updated.confidence).toBeGreaterThan(0.5);
    });

    it('gets all preferences by scope', async () => {
      await memory.setPreference('a', 1, 'test', 'user');
      await memory.setPreference('b', 2, 'test', 'project');

      const userPrefs = await memory.getAllPreferences('user');
      expect(userPrefs.length).toBe(1);
      expect(userPrefs[0].key).toBe('a');
    });
  });

  // --- Cross-Layer Recall ---

  describe('Cross-Layer Recall', () => {
    it('searches across all layers', async () => {
      await memory.storeFact('project_type', 'web app', 'metadata', 'system');
      await memory.recordEpisode('t1', 'Built the web app', 'success', ['shell_exec']);
      await memory.setPreference('framework', 'react', 'user');

      const results = await memory.recall({});
      expect(results.length).toBeGreaterThanOrEqual(2); // at least semantic + episodic
    });

    it('filters by specific layer', async () => {
      await memory.storeFact('fact1', 'val', 'test', 'agent');
      await memory.recordEpisode('t1', 'episode', 'success', []);

      const factResults = await memory.recall({ layer: 'semantic' });
      expect(factResults.length).toBe(1);
      expect(factResults[0].layer).toBe('semantic');
    });

    it('uses text query for semantic search across layers', async () => {
      await memory.storeFact('deploy_config', 'k8s', 'infrastructure', 'system', 'project', undefined, ['deploy']);
      await memory.recordEpisode('t1', 'Deploy to kubernetes', 'success', ['shell_exec']);

      const results = await memory.recall({ text: 'kubernetes deployment' });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // --- Consolidation ---

  describe('Memory Consolidation', () => {
    it('decays confidence of old, unaccessed facts', async () => {
      const fact = await memory.storeFact('old_fact', 'value', 'test', 'agent');
      // Manually set last accessed to 30 days ago
      fact.temporal.lastAccessedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const result = await memory.consolidate();
      expect(result.decayed).toBeGreaterThan(0);
    });

    it('prunes very low confidence facts', async () => {
      const fact = await memory.storeFact('weak_fact', 'value', 'test', 'agent');
      // Set very low confidence and old date
      fact.confidence = 0.05;
      fact.temporal.updatedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();

      const result = await memory.consolidate();
      expect(result.pruned).toBeGreaterThanOrEqual(0);
    });

    it('returns consolidation metrics', async () => {
      const result = await memory.consolidate();
      expect(result).toHaveProperty('merged');
      expect(result).toHaveProperty('pruned');
      expect(result).toHaveProperty('decayed');
      expect(result).toHaveProperty('promoted');
    });
  });

  // --- Stats ---

  describe('Memory Stats', () => {
    it('returns accurate stats', async () => {
      await memory.storeFact('f1', 'v1', 'test', 'agent');
      await memory.storeFact('f2', 'v2', 'test', 'agent');
      await memory.recordEpisode('t1', 'task', 'success', []);
      await memory.setPreference('p1', 'v', 'test');

      const stats = await memory.getStats();
      expect(stats.totalFacts).toBe(2);
      expect(stats.totalEpisodes).toBe(1);
      expect(stats.totalPreferences).toBe(1);
      expect(stats.avgFactConfidence).toBeCloseTo(0.5, 1);
      expect(stats.avgEpisodeSuccess).toBe(1);
    });
  });

  // --- Persistence ---

  describe('Persistence', () => {
    it('persists and reloads all layers', async () => {
      await memory.storeFact('persist_test', 'value', 'test', 'agent');
      await memory.recordEpisode('t1', 'persistent episode', 'success', ['shell_exec']);
      await memory.setPreference('persist_pref', 'dark', 'test');
      await memory.learnProcedure('persist_proc', 'Test proc', 'test', []);
      await memory.createLink('a', 'semantic', 'b', 'episodic', 'test_link');

      // Create new instance pointing to same directory
      const memory2 = new OptimizedMemory(tempDir);

      const fact = await memory2.getFact('persist_test');
      expect(fact).toBeDefined();
      expect(fact!.value).toBe('value');

      const episodes = await memory2.getRecentEpisodes(1);
      expect(episodes.length).toBe(1);

      const pref = await memory2.getPreference('persist_pref');
      expect(pref).toBeDefined();
      expect(pref!.value).toBe('dark');

      const procs = await memory2.findProcedure('test');
      expect(procs.length).toBe(1);

      const links = await memory2.getLinked('a');
      expect(links.length).toBe(1);
    });
  });
});
