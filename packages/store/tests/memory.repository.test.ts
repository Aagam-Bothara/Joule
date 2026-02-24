import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryRepository } from '../src/repositories/memory.repository.js';
import { freshDb } from './helpers.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let repo: MemoryRepository;

const now = '2024-01-01T00:00:00Z';

beforeEach(() => {
  db = freshDb();
  repo = new MemoryRepository(db);
});

describe('MemoryRepository — Semantic', () => {
  const fact = {
    id: 'fact-001',
    key: 'user.name',
    value: 'Alice',
    category: 'user_info',
    source: 'chat',
    confidence: 0.8,
    scope: 'user',
    scopeId: 'user-001',
    tags: ['personal', 'name'],
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };

  it('saves and retrieves semantic memory', () => {
    repo.saveSemantic(fact);
    const loaded = repo.getSemantic('fact-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.key).toBe('user.name');
    expect(loaded!.value).toBe('Alice');
    expect(loaded!.tags).toEqual(['personal', 'name']);
  });

  it('getSemanticByKey returns the latest non-superseded fact', () => {
    repo.saveSemantic(fact);
    const loaded = repo.getSemanticByKey('user.name');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('fact-001');
  });

  it('searchSemantic filters by category, scope, and confidence', () => {
    repo.saveSemantic(fact);
    repo.saveSemantic({ ...fact, id: 'fact-002', key: 'user.age', value: 30, confidence: 0.3 });

    const results = repo.searchSemantic({ category: 'user_info', minConfidence: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('fact-001');
  });

  it('searchSemantic filters by tags', () => {
    repo.saveSemantic(fact);
    repo.saveSemantic({ ...fact, id: 'fact-002', key: 'user.age', tags: ['personal', 'age'] });

    const results = repo.searchSemantic({ tags: ['name'] });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('user.name');
  });

  it('supersedeSemantic marks old fact as superseded', () => {
    repo.saveSemantic(fact);
    repo.saveSemantic({ ...fact, id: 'fact-002', key: 'user.name', value: 'Bob', supersedes: 'fact-001' });
    repo.supersedeSemantic('fact-001', 'fact-002');

    const all = repo.getAllSemantic();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('fact-002');

    const allIncluding = repo.getAllSemantic({ includeSuperseded: true });
    expect(allIncluding).toHaveLength(2);
  });

  it('updateSemanticConfidence updates the confidence', () => {
    repo.saveSemantic(fact);
    repo.updateSemanticConfidence('fact-001', 0.95);

    const loaded = repo.getSemantic('fact-001');
    expect(loaded!.confidence).toBe(0.95);
  });

  it('deleteSemanticBelow prunes low-confidence old facts', () => {
    repo.saveSemantic({ ...fact, id: 'fact-001', confidence: 0.05, updatedAt: '2020-01-01T00:00:00Z' });
    repo.saveSemantic({ ...fact, id: 'fact-002', confidence: 0.8 });

    const deleted = repo.deleteSemanticBelow(0.1, 365);
    expect(deleted).toBe(1);
    expect(repo.getSemantic('fact-001')).toBeNull();
    expect(repo.getSemantic('fact-002')).not.toBeNull();
  });
});

describe('MemoryRepository — Episodic', () => {
  const episode = {
    id: 'ep-001',
    taskId: 'task-001',
    summary: 'Created a test file',
    outcome: 'success',
    toolsUsed: ['file_write', 'shell_exec'],
    stepsCompleted: 2,
    totalSteps: 2,
    energyUsed: 0.001,
    carbonUsed: 0.0005,
    costUsd: 0.01,
    durationMs: 5000,
    scope: 'project',
    tags: ['file', 'test'],
    context: 'User asked to create a file',
    lessonsLearned: undefined,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };

  it('saves and retrieves recent episodes', () => {
    repo.saveEpisodic(episode);
    const recent = repo.getRecentEpisodic(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].taskId).toBe('task-001');
    expect(recent[0].toolsUsed).toEqual(['file_write', 'shell_exec']);
  });

  it('searchEpisodic filters by outcome and scope', () => {
    repo.saveEpisodic(episode);
    repo.saveEpisodic({ ...episode, id: 'ep-002', taskId: 'task-002', outcome: 'failed' });

    const failed = repo.searchEpisodic({ outcome: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('ep-002');
  });

  it('pruneEpisodic keeps only N most recent', () => {
    for (let i = 0; i < 10; i++) {
      repo.saveEpisodic({
        ...episode,
        id: `ep-${i}`,
        createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      });
    }

    const pruned = repo.pruneEpisodic(5);
    expect(pruned).toBe(5);
    expect(repo.getAllEpisodic()).toHaveLength(5);
  });
});

describe('MemoryRepository — Procedural', () => {
  const proc = {
    id: 'proc-001',
    name: 'create-file',
    description: 'Create a file with content',
    pattern: { trigger: 'create file', steps: [{ tool: 'file_write', argTemplate: {}, description: 'Write file' }] },
    confidence: 0.7,
    successRate: 0.9,
    timesUsed: 5,
    scope: 'project',
    tags: ['file'],
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };

  it('saves and retrieves by name', () => {
    repo.saveProcedural(proc);
    const loaded = repo.getProceduralByName('create-file', 'project');
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('create-file');
    expect(loaded!.pattern).toEqual(proc.pattern);
  });

  it('getAllProcedural returns all sorted by usage', () => {
    repo.saveProcedural(proc);
    repo.saveProcedural({ ...proc, id: 'proc-002', name: 'run-test', timesUsed: 10 });

    const all = repo.getAllProcedural();
    expect(all).toHaveLength(2);
    expect(all[0].name).toBe('run-test'); // higher timesUsed
  });

  it('updateProceduralUsage updates usage stats', () => {
    repo.saveProcedural(proc);
    repo.updateProceduralUsage('proc-001', 10, 0.95, 0.9);

    const loaded = repo.getProceduralByName('create-file', 'project');
    expect(loaded!.timesUsed).toBe(10);
    expect(loaded!.successRate).toBe(0.95);
    expect(loaded!.confidence).toBe(0.9);
  });
});

describe('MemoryRepository — Preferences', () => {
  const pref = {
    id: 'pref-001',
    key: 'output.format',
    value: 'json',
    learnedFrom: 'user said "use json"',
    confidence: 0.7,
    scope: 'user',
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };

  it('saves and retrieves preference by key', () => {
    repo.savePreference(pref);
    const loaded = repo.getPreference('output.format');
    expect(loaded).not.toBeNull();
    expect(loaded!.value).toBe('json');
    expect(loaded!.learnedFrom).toBe('user said "use json"');
  });

  it('getAllPreferences supports scope filter', () => {
    repo.savePreference(pref);
    repo.savePreference({ ...pref, id: 'pref-002', key: 'color', scope: 'project' });

    const userPrefs = repo.getAllPreferences('user');
    expect(userPrefs).toHaveLength(1);
    expect(userPrefs[0].key).toBe('output.format');
  });
});

describe('MemoryRepository — Links', () => {
  const link = {
    id: 'link-001',
    sourceId: 'ep-001',
    sourceType: 'episodic',
    targetId: 'fact-001',
    targetType: 'semantic',
    relationship: 'used_knowledge',
    strength: 0.8,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  };

  it('saves and retrieves links by source or target', () => {
    repo.saveLink(link);

    const bySource = repo.getLinked('ep-001');
    expect(bySource).toHaveLength(1);
    expect(bySource[0].relationship).toBe('used_knowledge');

    const byTarget = repo.getLinked('fact-001');
    expect(byTarget).toHaveLength(1);
  });

  it('filters links by relationship', () => {
    repo.saveLink(link);
    repo.saveLink({ ...link, id: 'link-002', relationship: 'caused_by' });

    const filtered = repo.getLinked('ep-001', 'caused_by');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('link-002');
  });

  it('pruneOrphanLinks removes links with missing endpoints', () => {
    repo.saveLink(link); // Both source and target don't exist in memory tables
    const pruned = repo.pruneOrphanLinks();
    expect(pruned).toBe(1);
    expect(repo.getAllLinks()).toHaveLength(0);
  });
});

describe('MemoryRepository — Failures', () => {
  const failure = {
    id: 'fail-001',
    toolName: 'shell_exec',
    errorSignature: 'Permission denied: <path>',
    context: 'Tried to write to /etc',
    resolution: 'Use sudo or write to home directory',
    occurrences: 3,
    lastSeen: now,
  };

  it('saves and retrieves failure by id', () => {
    repo.saveFailure(failure);
    const loaded = repo.getFailure('fail-001');
    expect(loaded).not.toBeNull();
    expect(loaded!.toolName).toBe('shell_exec');
    expect(loaded!.occurrences).toBe(3);
  });

  it('getFailuresByTool returns failures sorted by occurrences', () => {
    repo.saveFailure(failure);
    repo.saveFailure({ ...failure, id: 'fail-002', errorSignature: 'Timeout', occurrences: 10 });

    const results = repo.getFailuresByTool('shell_exec');
    expect(results).toHaveLength(2);
    expect(results[0].occurrences).toBe(10);
  });

  it('updateFailure updates occurrences and resolution', () => {
    repo.saveFailure(failure);
    repo.updateFailure('fail-001', 5, '2024-06-01T00:00:00Z', 'Use chmod first');

    const loaded = repo.getFailure('fail-001');
    expect(loaded!.occurrences).toBe(5);
    expect(loaded!.resolution).toBe('Use chmod first');
  });
});

describe('MemoryRepository — Bulk & Stats', () => {
  it('saveAll persists multiple layers atomically', () => {
    repo.saveAll({
      semantic: [{
        id: 'f-1', key: 'k', value: 'v', category: 'c', source: 's',
        confidence: 0.5, scope: 'project', tags: [],
        createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
      }],
      episodic: [{
        id: 'e-1', taskId: 't-1', summary: 'sum', outcome: 'success',
        toolsUsed: [], stepsCompleted: 1, totalSteps: 1,
        energyUsed: 0, carbonUsed: 0, costUsd: 0, durationMs: 0,
        scope: 'project', tags: [],
        createdAt: now, updatedAt: now, lastAccessedAt: now, accessCount: 0,
      }],
      failures: [{
        id: 'fl-1', toolName: 'shell', errorSignature: 'err',
        context: 'ctx', occurrences: 1, lastSeen: now,
      }],
    });

    const counts = repo.counts();
    expect(counts.semantic).toBe(1);
    expect(counts.episodic).toBe(1);
    expect(counts.failures).toBe(1);
    expect(counts.procedural).toBe(0);
    expect(counts.preferences).toBe(0);
    expect(counts.links).toBe(0);
  });

  it('counts returns accurate counts per layer', () => {
    const counts = repo.counts();
    expect(counts.semantic).toBe(0);
    expect(counts.episodic).toBe(0);
  });
});
