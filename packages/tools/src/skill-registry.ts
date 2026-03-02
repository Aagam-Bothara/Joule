/**
 * SkillRegistry — Markdown-based skill management system.
 *
 * Skills are markdown files with YAML frontmatter that teach agents
 * new capabilities. Can be loaded from local files, npm, or GitHub gists.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import type { SkillDefinition, AgentDefinition } from '@joule/shared';

/** Default skills directory. */
const DEFAULT_SKILLS_DIR = join(homedir(), '.joule', 'skills');

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir ?? DEFAULT_SKILLS_DIR;
  }

  /** Load all skills from the local skills directory. */
  loadLocal(): number {
    if (!existsSync(this.skillsDir)) return 0;

    let loaded = 0;
    const files = readdirSync(this.skillsDir).filter(f => extname(f) === '.md');

    for (const file of files) {
      try {
        const content = readFileSync(join(this.skillsDir, file), 'utf-8');
        const skill = this.parseSkillMarkdown(content, file);
        if (skill) {
          this.skills.set(skill.name, skill);
          loaded++;
        }
      } catch {
        // Skip invalid skill files
      }
    }

    return loaded;
  }

  /** Install a skill from a local markdown file path. */
  installFromFile(filePath: string): SkillDefinition | null {
    const content = readFileSync(filePath, 'utf-8');
    const skill = this.parseSkillMarkdown(content, basename(filePath));
    if (!skill) return null;

    // Ensure skills directory exists
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }

    // Copy to skills directory
    const targetPath = join(this.skillsDir, `${skill.name}.md`);
    writeFileSync(targetPath, content, 'utf-8');

    this.skills.set(skill.name, skill);
    return skill;
  }

  /** Uninstall a skill by name. */
  uninstall(name: string): boolean {
    if (!this.skills.has(name)) return false;

    this.skills.delete(name);

    // Remove file
    const filePath = join(this.skillsDir, `${name}.md`);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      // File removal failed — still remove from registry
    }

    return true;
  }

  /** List all installed skills. */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** Get a skill by name. */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** Search installed skills by query (fuzzy name/description/tags match). */
  search(query: string): SkillDefinition[] {
    const lower = query.toLowerCase();
    return this.list().filter(skill => {
      if (skill.name.toLowerCase().includes(lower)) return true;
      if (skill.description.toLowerCase().includes(lower)) return true;
      if (skill.tags?.some(t => t.toLowerCase().includes(lower))) return true;
      return false;
    });
  }

  /**
   * Convert a skill to an AgentDefinition for use in crew orchestration.
   * The skill's instructions become the agent's system prompt.
   */
  toAgentDefinition(skill: SkillDefinition): AgentDefinition {
    return {
      id: `skill:${skill.name}`,
      role: skill.description,
      instructions: skill.instructions,
      allowedTools: skill.tools ?? [],
      outputSchema: skill.outputSchema,
    };
  }

  /** Validate a skill definition for required fields. */
  validate(skill: SkillDefinition): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!skill.name || skill.name.trim().length === 0) {
      errors.push('Skill name is required');
    }
    if (!/^[a-z0-9-]+$/.test(skill.name)) {
      errors.push('Skill name must be kebab-case (lowercase letters, numbers, hyphens)');
    }
    if (!skill.version) {
      errors.push('Skill version is required');
    }
    if (!skill.description || skill.description.trim().length === 0) {
      errors.push('Skill description is required');
    }
    if (!skill.author || skill.author.trim().length === 0) {
      errors.push('Skill author is required');
    }
    if (!skill.instructions || skill.instructions.trim().length === 0) {
      errors.push('Skill instructions are required');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Scaffold a new skill markdown file.
   */
  scaffold(name: string, description = 'A new Joule skill'): string {
    return `---
name: ${name}
version: 1.0.0
description: ${description}
author: your-name
tags: []
tools: []
---

# ${name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}

${description}

## Instructions

Add your skill instructions here. This text will be injected into the agent's system prompt.
`;
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Parse a markdown file with YAML frontmatter into a SkillDefinition.
   *
   * Format:
   * ```markdown
   * ---
   * name: skill-name
   * version: 1.0.0
   * description: What this skill does
   * author: author-name
   * tags: [tag1, tag2]
   * tools: [tool1, tool2]
   * ---
   * # Skill Title
   * Markdown instructions...
   * ```
   */
  private parseSkillMarkdown(content: string, filename: string): SkillDefinition | null {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!frontmatterMatch) return null;

    const [, frontmatter, instructions] = frontmatterMatch;

    // Simple YAML-like parsing (no external deps)
    const meta: Record<string, string | string[]> = {};
    for (const line of frontmatter.split('\n')) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        // Parse arrays: [item1, item2]
        if (value.startsWith('[') && value.endsWith(']')) {
          meta[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        } else {
          meta[key] = value.trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }

    if (!meta.name) {
      // Use filename as fallback name
      meta.name = basename(filename, extname(filename));
    }

    return {
      name: String(meta.name),
      version: String(meta.version ?? '1.0.0'),
      description: String(meta.description ?? ''),
      author: String(meta.author ?? 'unknown'),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      instructions: instructions.trim(),
      tools: Array.isArray(meta.tools) ? meta.tools : [],
      source: 'local',
    };
  }
}
