import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '@joule/shared';

// Legacy flat memory for backward compatibility
const MEMORY_DIR = join(process.cwd(), '.joule');
const MEMORY_FILE = join(MEMORY_DIR, 'memory.json');

async function loadMemory(): Promise<Record<string, unknown>> {
  if (!existsSync(MEMORY_FILE)) return {};
  try {
    const content = await readFile(MEMORY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveMemory(data: Record<string, unknown>): Promise<void> {
  if (!existsSync(MEMORY_DIR)) {
    await mkdir(MEMORY_DIR, { recursive: true });
  }
  await writeFile(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// --- Backward-compatible memory_put / memory_get ---

const putInputSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.unknown(),
});

const putOutputSchema = z.object({
  key: z.string(),
  stored: z.boolean(),
  previousValue: z.unknown().optional(),
});

export const memoryPutTool: ToolDefinition = {
  name: 'memory_put',
  description: 'Store a key-value pair in persistent project memory (.joule/memory.json)',
  inputSchema: putInputSchema,
  outputSchema: putOutputSchema,
  tags: ['memory', 'persistence'],
  async execute(input) {
    const parsed = input as z.infer<typeof putInputSchema>;
    const memory = await loadMemory();
    const previousValue = memory[parsed.key];
    memory[parsed.key] = parsed.value;
    await saveMemory(memory);
    return { key: parsed.key, stored: true, previousValue };
  },
};

const getInputSchema = z.object({
  key: z.string().min(1).max(256),
});

const getOutputSchema = z.object({
  key: z.string(),
  found: z.boolean(),
  value: z.unknown().optional(),
});

export const memoryGetTool: ToolDefinition = {
  name: 'memory_get',
  description: 'Retrieve a value from persistent project memory by key',
  inputSchema: getInputSchema,
  outputSchema: getOutputSchema,
  tags: ['memory', 'persistence'],
  async execute(input) {
    const parsed = input as z.infer<typeof getInputSchema>;
    const memory = await loadMemory();
    const value = memory[parsed.key];
    return { key: parsed.key, found: value !== undefined, value };
  },
};

// --- Enhanced memory tools (5-layer cognitive system) ---

const storeInputSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.unknown(),
  category: z.string().min(1).max(64).default('general'),
  source: z.string().min(1).max(128).default('agent'),
  tags: z.array(z.string()).default([]),
});

const storeOutputSchema = z.object({
  id: z.string(),
  key: z.string(),
  stored: z.boolean(),
  isUpdate: z.boolean(),
  confidence: z.number(),
});

export const memoryStoreTool: ToolDefinition = {
  name: 'memory_store',
  description: 'Store a fact in the 5-layer cognitive memory system. Facts persist across sessions, build confidence over time, and are searchable via semantic similarity. Use this to remember important information about the user, project, or environment.',
  inputSchema: storeInputSchema,
  outputSchema: storeOutputSchema,
  tags: ['memory', 'persistence', 'facts', 'cognitive'],
  async execute(input) {
    const parsed = input as z.infer<typeof storeInputSchema>;
    const memory = await loadMemory();
    const isUpdate = parsed.key in memory;
    memory[parsed.key] = { value: parsed.value, category: parsed.category, source: parsed.source, tags: parsed.tags };
    await saveMemory(memory);
    return {
      id: parsed.key,
      key: parsed.key,
      stored: true,
      isUpdate,
      confidence: isUpdate ? 0.6 : 0.5,
    };
  },
};

const recallInputSchema = z.object({
  query: z.string().optional().describe('Natural language search query for semantic similarity matching'),
  category: z.string().optional(),
  key: z.string().optional(),
  limit: z.number().min(1).max(100).default(10),
});

const recallOutputSchema = z.object({
  results: z.array(z.object({
    key: z.string(),
    value: z.unknown(),
    confidence: z.number().optional(),
  })),
  count: z.number(),
});

export const memoryRecallTool: ToolDefinition = {
  name: 'memory_recall',
  description: 'Search agent memory using semantic similarity or filters. Searches across all memory layers (facts, episodes, preferences, procedures). Supports natural language queries for finding relevant past knowledge.',
  inputSchema: recallInputSchema,
  outputSchema: recallOutputSchema,
  tags: ['memory', 'persistence', 'search', 'semantic'],
  async execute(input) {
    const parsed = input as z.infer<typeof recallInputSchema>;
    const memory = await loadMemory();
    let entries = Object.entries(memory).map(([k, v]) => ({
      key: k,
      value: v,
      confidence: (v as any)?.confidence ?? 0.5,
    }));

    if (parsed.key) {
      entries = entries.filter(e => e.key.includes(parsed.key!));
    }
    if (parsed.category) {
      entries = entries.filter(e => {
        const val = e.value as Record<string, unknown>;
        return val?.category === parsed.category;
      });
    }

    // Text similarity search if query provided
    if (parsed.query) {
      const queryLower = parsed.query.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 1);
      entries = entries
        .map(e => {
          const text = `${e.key} ${JSON.stringify(e.value)}`.toLowerCase();
          const matchCount = queryWords.filter(w => text.includes(w)).length;
          return { ...e, score: matchCount / (queryWords.length || 1) };
        })
        .filter(e => e.score > 0)
        .sort((a, b) => b.score - a.score);
    }

    entries = entries.slice(0, parsed.limit);
    return { results: entries, count: entries.length };
  },
};

const episodesInputSchema = z.object({
  limit: z.number().min(1).max(50).default(10),
  query: z.string().optional().describe('Search for similar past task executions'),
});

const episodesOutputSchema = z.object({
  episodes: z.array(z.object({
    taskId: z.string(),
    summary: z.string(),
    outcome: z.string(),
    timestamp: z.string(),
    toolsUsed: z.array(z.string()).optional(),
    lessonsLearned: z.string().optional(),
  })),
  count: z.number(),
});

export const memoryEpisodesTool: ToolDefinition = {
  name: 'memory_episodes',
  description: 'Retrieve past task execution episodes. Shows what tasks were run before, whether they succeeded, what tools were used, and lessons learned. Supports semantic search.',
  inputSchema: episodesInputSchema,
  outputSchema: episodesOutputSchema,
  tags: ['memory', 'persistence', 'episodes', 'history'],
  async execute(input) {
    const parsed = input as z.infer<typeof episodesInputSchema>;
    const episodesFile = join(process.cwd(), '.joule', 'memory', 'episodes.json');
    try {
      const content = await readFile(episodesFile, 'utf-8');
      const episodes = JSON.parse(content) as Array<{
        taskId: string; summary: string; outcome: string; timestamp?: string;
        temporal?: { createdAt: string }; toolsUsed?: string[]; lessonsLearned?: string;
      }>;
      let recent = episodes
        .sort((a, b) => {
          const aDate = a.temporal?.createdAt ?? a.timestamp ?? '';
          const bDate = b.temporal?.createdAt ?? b.timestamp ?? '';
          return bDate.localeCompare(aDate);
        });

      if (parsed.query) {
        const queryLower = parsed.query.toLowerCase();
        recent = recent.filter(ep =>
          ep.summary.toLowerCase().includes(queryLower) ||
          ep.toolsUsed?.some(t => t.toLowerCase().includes(queryLower)),
        );
      }

      recent = recent.slice(0, parsed.limit);
      return {
        episodes: recent.map(ep => ({
          taskId: ep.taskId,
          summary: ep.summary,
          outcome: ep.outcome,
          timestamp: ep.temporal?.createdAt ?? ep.timestamp ?? '',
          toolsUsed: ep.toolsUsed,
          lessonsLearned: ep.lessonsLearned,
        })),
        count: recent.length,
      };
    } catch {
      return { episodes: [], count: 0 };
    }
  },
};

const preferencesInputSchema = z.object({
  key: z.string().optional(),
  action: z.enum(['get', 'set']).default('get'),
  value: z.unknown().optional(),
});

const preferencesOutputSchema = z.object({
  preferences: z.array(z.object({
    key: z.string(),
    value: z.unknown(),
    confidence: z.number().optional(),
  })),
  count: z.number(),
});

export const memoryPreferencesTool: ToolDefinition = {
  name: 'memory_preferences',
  description: 'Get or set learned user preferences. Preferences persist across sessions and help the agent adapt to user working style.',
  inputSchema: preferencesInputSchema,
  outputSchema: preferencesOutputSchema,
  tags: ['memory', 'persistence', 'preferences', 'learning'],
  async execute(input) {
    const parsed = input as z.infer<typeof preferencesInputSchema>;
    const prefsFile = join(process.cwd(), '.joule', 'memory', 'preferences.json');

    try {
      const content = await readFile(prefsFile, 'utf-8');
      const prefs = JSON.parse(content) as Array<{
        key: string; value: unknown; confidence?: number;
        temporal?: { createdAt: string };
      }>;

      if (parsed.action === 'set' && parsed.key && parsed.value !== undefined) {
        const existing = prefs.find(p => p.key === parsed.key);
        if (existing) {
          existing.value = parsed.value;
          existing.confidence = Math.min(1, (existing.confidence ?? 0.5) + 0.1);
        } else {
          prefs.push({ key: parsed.key, value: parsed.value, confidence: 0.5 });
        }
        const dir = join(process.cwd(), '.joule', 'memory');
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(prefsFile, JSON.stringify(prefs, null, 2), 'utf-8');
      }

      let results = prefs;
      if (parsed.key) {
        results = results.filter(p => p.key === parsed.key);
      }
      return {
        preferences: results.map(p => ({
          key: p.key,
          value: p.value,
          confidence: p.confidence ?? 0.5,
        })),
        count: results.length,
      };
    } catch {
      if (parsed.action === 'set' && parsed.key && parsed.value !== undefined) {
        const prefs = [{ key: parsed.key, value: parsed.value, confidence: 0.5 }];
        const dir = join(process.cwd(), '.joule', 'memory');
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(prefsFile, JSON.stringify(prefs, null, 2), 'utf-8');
        return { preferences: prefs, count: 1 };
      }
      return { preferences: [], count: 0 };
    }
  },
};

// --- Memory Stats Tool ---

const statsInputSchema = z.object({});
const statsOutputSchema = z.object({
  totalFacts: z.number(),
  totalEpisodes: z.number(),
  totalProcedures: z.number(),
  totalPreferences: z.number(),
  totalLinks: z.number(),
  avgConfidence: z.number(),
  successRate: z.number(),
});

export const memoryStatsTool: ToolDefinition = {
  name: 'memory_stats',
  description: 'Get statistics about the agent cognitive memory system — total facts, episodes, procedures, preferences, associative links, and quality metrics.',
  inputSchema: statsInputSchema,
  outputSchema: statsOutputSchema,
  tags: ['memory', 'stats', 'diagnostics'],
  async execute() {
    const memDir = join(process.cwd(), '.joule', 'memory');
    const readJsonSafe = async <T>(file: string, fallback: T): Promise<T> => {
      try {
        const content = await readFile(join(memDir, file), 'utf-8');
        return JSON.parse(content) as T;
      } catch { return fallback; }
    };

    const semantics = await readJsonSafe<any[]>('semantics.json', []);
    const episodes = await readJsonSafe<any[]>('episodes.json', []);
    const procedures = await readJsonSafe<any[]>('procedures.json', []);
    const preferences = await readJsonSafe<any[]>('preferences.json', []);
    const links = await readJsonSafe<any[]>('links.json', []);

    const activeFacts = semantics.filter((f: any) => !f.supersededBy);
    const avgConf = activeFacts.length > 0
      ? activeFacts.reduce((s: number, f: any) => s + (f.confidence ?? 0), 0) / activeFacts.length
      : 0;
    const successEps = episodes.filter((e: any) => e.outcome === 'success');
    const successRate = episodes.length > 0 ? successEps.length / episodes.length : 0;

    return {
      totalFacts: activeFacts.length,
      totalEpisodes: episodes.length,
      totalProcedures: procedures.length,
      totalPreferences: preferences.length,
      totalLinks: links.length,
      avgConfidence: Math.round(avgConf * 100) / 100,
      successRate: Math.round(successRate * 100) / 100,
    };
  },
};
