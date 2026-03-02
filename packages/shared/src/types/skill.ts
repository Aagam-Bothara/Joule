/**
 * Skill system types.
 *
 * Skills are markdown-based instruction sets that teach agents new capabilities.
 * They can be installed from npm, GitHub gists, or local files.
 */

/** A fully loaded skill definition. */
export interface SkillDefinition {
  /** Unique skill name (kebab-case). */
  name: string;
  /** Semantic version. */
  version: string;
  /** Short description (1-2 sentences). */
  description: string;
  /** Author name or org. */
  author: string;
  /** Searchable tags. */
  tags?: string[];
  /** The skill's markdown instructions (injected into agent system prompt). */
  instructions: string;
  /** Tools this skill requires to function. */
  tools?: string[];
  /** JSON Schema for expected input. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema for expected output. */
  outputSchema?: Record<string, unknown>;
  /** Example input/output pairs. */
  examples?: Array<{ input: string; output: string }>;
  /** Where this skill was loaded from. */
  source: 'local' | 'npm' | 'gist' | 'community';
}

/** A skill entry in a remote registry (search result). */
export interface SkillRegistryEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  downloads?: number;
  rating?: number;
  tags: string[];
  source: string;
  url?: string;
}

/** Result from a skill search. */
export interface SkillSearchResult {
  entries: SkillRegistryEntry[];
  total: number;
}
