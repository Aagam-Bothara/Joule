/**
 * Automatic Fact Extraction Engine
 *
 * Analyzes task descriptions, results, and conversations to automatically
 * extract and store facts, preferences, and entities in memory.
 *
 * This is one of Joule's key advantages over OpenClaw — no manual
 * instrumentation needed. The agent learns from every interaction.
 *
 * Extraction happens via pattern matching (no LLM calls = zero cost).
 */

import type {
  ExtractedFacts,
  SemanticMemory,
  EpisodicMemory,
} from '@joule/shared';
import type { OptimizedMemory } from './optimized-memory.js';

// Patterns for extracting preferences from user input
const PREFERENCE_PATTERNS: Array<{ pattern: RegExp; keyExtractor: (m: RegExpMatchArray) => string; valueExtractor: (m: RegExpMatchArray) => string }> = [
  {
    pattern: /(?:i |I )(?:prefer|like|want|need|always use|usually use)\s+(.+?)(?:\s+(?:over|instead of|rather than)\s+(.+))?$/i,
    keyExtractor: (m) => `preference:${m[1].trim().toLowerCase().slice(0, 50)}`,
    valueExtractor: (m) => m[2] ? `${m[1].trim()} over ${m[2].trim()}` : m[1].trim(),
  },
  {
    pattern: /(?:use|set|switch to|change to|enable|disable)\s+(.+?)$/i,
    keyExtractor: (m) => `setting:${m[1].trim().toLowerCase().slice(0, 50)}`,
    valueExtractor: (m) => m[1].trim(),
  },
  {
    pattern: /(?:my |the )(?:name|email|project|company|team|stack)\s+(?:is|are)\s+(.+)/i,
    keyExtractor: (m) => `identity:${m[0].match(/(?:name|email|project|company|team|stack)/i)![0].toLowerCase()}`,
    valueExtractor: (m) => m[1].trim(),
  },
];

// Patterns for extracting facts from task results
const FACT_PATTERNS: Array<{ pattern: RegExp; category: string; keyExtractor: (m: RegExpMatchArray) => string; valueExtractor: (m: RegExpMatchArray) => string }> = [
  {
    pattern: /(?:the |this )(?:file|directory|folder|path)\s+(?:is|was|exists at|located at)\s+["']?([^\s"']+)["']?/i,
    category: 'filesystem',
    keyExtractor: (m) => `path:${m[1]}`,
    valueExtractor: (m) => m[1],
  },
  {
    pattern: /(?:using|running|installed)\s+([\w.-]+)\s+(?:version|v)\s*([\d.]+)/i,
    category: 'environment',
    keyExtractor: (m) => `version:${m[1].toLowerCase()}`,
    valueExtractor: (m) => m[2],
  },
  {
    pattern: /(?:port|PORT)\s*(?:is|=|:|\s)\s*(\d+)/i,
    category: 'configuration',
    keyExtractor: () => 'config:port',
    valueExtractor: (m) => m[1],
  },
  {
    pattern: /error:\s*(.+)/i,
    category: 'error',
    keyExtractor: (m) => `error:${m[1].slice(0, 40).toLowerCase().replace(/\s+/g, '_')}`,
    valueExtractor: (m) => m[1],
  },
];

// Entity types to extract
const ENTITY_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/g, type: 'proper_noun' },
  { pattern: /\b(https?:\/\/[^\s]+)\b/g, type: 'url' },
  { pattern: /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi, type: 'email' },
  { pattern: /\b((?:\d{1,3}\.){3}\d{1,3}(?::\d+)?)\b/g, type: 'ip_address' },
  { pattern: /\b([a-z][\w.-]*\.(?:ts|js|py|go|rs|java|tsx|jsx|css|html|json|yaml|yml|toml|md))\b/gi, type: 'filename' },
];

export class FactExtractor {
  constructor(private memory: OptimizedMemory) {}

  /** Extract facts from a user's task description */
  async extractFromInput(text: string): Promise<ExtractedFacts> {
    const result: ExtractedFacts = { facts: [], preferences: [], entities: [] };

    // Extract preferences
    for (const { pattern, keyExtractor, valueExtractor } of PREFERENCE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        result.preferences.push({
          key: keyExtractor(match),
          value: valueExtractor(match),
        });
      }
    }

    // Extract entities
    for (const { pattern, type } of ENTITY_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(text)) !== null) {
        result.entities.push({
          name: match[1],
          type,
          attributes: {},
        });
      }
    }

    return result;
  }

  /** Extract facts from a task result/output */
  async extractFromResult(text: string): Promise<ExtractedFacts> {
    const result: ExtractedFacts = { facts: [], preferences: [], entities: [] };

    // Extract facts
    for (const { pattern, category, keyExtractor, valueExtractor } of FACT_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        result.facts.push({
          key: keyExtractor(match),
          value: valueExtractor(match),
          category,
          confidence: 0.6,
        });
      }
    }

    // Extract entities
    for (const { pattern, type } of ENTITY_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(text)) !== null) {
        result.entities.push({
          name: match[1],
          type,
          attributes: {},
        });
      }
    }

    return result;
  }

  /** Process extracted facts and store them in memory */
  async storeExtracted(extracted: ExtractedFacts, source: string): Promise<void> {
    // Store facts
    for (const fact of extracted.facts) {
      await this.memory.storeFact(
        fact.key,
        fact.value,
        fact.category,
        source,
        'project',
        undefined,
        [fact.category],
      );
    }

    // Store preferences
    for (const pref of extracted.preferences) {
      await this.memory.setPreference(pref.key, pref.value, source, 'user');
    }

    // Store entities as facts
    for (const entity of extracted.entities) {
      await this.memory.storeFact(
        `entity:${entity.type}:${entity.name}`,
        entity.attributes,
        'entity',
        source,
        'project',
        undefined,
        [entity.type, 'entity'],
      );
    }
  }

  /** Learn from a completed task execution */
  async learnFromExecution(
    taskDescription: string,
    result: string,
    episode: EpisodicMemory,
  ): Promise<void> {
    // Extract from both input and output
    const inputFacts = await this.extractFromInput(taskDescription);
    const resultFacts = await this.extractFromResult(result);

    // Store extracted knowledge
    await this.storeExtracted(inputFacts, `task:${episode.taskId}:input`);
    await this.storeExtracted(resultFacts, `task:${episode.taskId}:result`);

    // Learn tool patterns for procedural memory
    if (episode.outcome === 'success' && episode.toolsUsed.length > 0) {
      // Build a simple trigger from the task description keywords
      const triggerWords = taskDescription.toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 5)
        .join(' ');

      if (triggerWords.length > 0) {
        const existingProcs = await this.memory.findProcedure(taskDescription, 1);
        if (existingProcs.length === 0) {
          // No existing procedure — learn a new one
          await this.memory.learnProcedure(
            `auto:${episode.toolsUsed[0]}:${episode.id.slice(-6)}`,
            `Learned from task: ${taskDescription.slice(0, 100)}`,
            triggerWords,
            episode.toolsUsed.map(tool => ({
              tool,
              argTemplate: {},
              description: `Use ${tool}`,
            })),
            [...episode.tags, 'auto-learned'],
          );
        } else {
          // Existing procedure — boost confidence
          await this.memory.recordProcedureUsage(existingProcs[0].id, true);
        }
      }
    }
  }
}
