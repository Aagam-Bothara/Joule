import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistry } from '../src/skill-registry.js';

const TEST_DIR = join(tmpdir(), 'joule-test-skills-' + Date.now());

const SAMPLE_SKILL = `---
name: test-skill
version: 1.0.0
description: A test skill for unit tests
author: joule-team
tags: [test, sample]
tools: [file_read, shell_exec]
---

# Test Skill

You are a test skill agent. Follow these instructions carefully.

## Steps
1. Read the input
2. Process it
3. Return the result
`;

const MINIMAL_SKILL = `---
name: minimal
version: 0.1.0
description: Minimal skill
author: test
---

Just do the thing.
`;

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    registry = new SkillRegistry(TEST_DIR);
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // cleanup failure is fine
    }
  });

  describe('loadLocal', () => {
    it('should load skills from directory', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      writeFileSync(join(TEST_DIR, 'minimal.md'), MINIMAL_SKILL);

      const count = registry.loadLocal();
      expect(count).toBe(2);
      expect(registry.list().length).toBe(2);
    });

    it('should return 0 for empty directory', () => {
      const count = registry.loadLocal();
      expect(count).toBe(0);
    });

    it('should skip non-markdown files', () => {
      writeFileSync(join(TEST_DIR, 'readme.txt'), 'not a skill');
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);

      const count = registry.loadLocal();
      expect(count).toBe(1);
    });
  });

  describe('parsing', () => {
    it('should parse frontmatter and instructions', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      registry.loadLocal();

      const skill = registry.get('test-skill');
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('test-skill');
      expect(skill!.version).toBe('1.0.0');
      expect(skill!.description).toBe('A test skill for unit tests');
      expect(skill!.author).toBe('joule-team');
      expect(skill!.tags).toEqual(['test', 'sample']);
      expect(skill!.tools).toEqual(['file_read', 'shell_exec']);
      expect(skill!.instructions).toContain('Test Skill');
      expect(skill!.source).toBe('local');
    });

    it('should handle minimal frontmatter', () => {
      writeFileSync(join(TEST_DIR, 'minimal.md'), MINIMAL_SKILL);
      registry.loadLocal();

      const skill = registry.get('minimal');
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('minimal');
      expect(skill!.tags).toEqual([]);
      expect(skill!.tools).toEqual([]);
    });
  });

  describe('installFromFile', () => {
    it('should install a skill from a file path', () => {
      const sourcePath = join(TEST_DIR, 'source.md');
      writeFileSync(sourcePath, SAMPLE_SKILL);

      const skill = registry.installFromFile(sourcePath);
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe('test-skill');
      expect(registry.get('test-skill')).toBeDefined();

      // Should have copied to skills dir
      expect(existsSync(join(TEST_DIR, 'test-skill.md'))).toBe(true);
    });
  });

  describe('uninstall', () => {
    it('should remove a skill', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      registry.loadLocal();

      expect(registry.get('test-skill')).toBeDefined();
      const removed = registry.uninstall('test-skill');
      expect(removed).toBe(true);
      expect(registry.get('test-skill')).toBeUndefined();
    });

    it('should return false for unknown skill', () => {
      expect(registry.uninstall('nonexistent')).toBe(false);
    });
  });

  describe('search', () => {
    it('should find skills by name', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      writeFileSync(join(TEST_DIR, 'minimal.md'), MINIMAL_SKILL);
      registry.loadLocal();

      const results = registry.search('test');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('test-skill');
    });

    it('should find skills by tag', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      registry.loadLocal();

      const results = registry.search('sample');
      expect(results.length).toBe(1);
    });

    it('should return empty for no matches', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      registry.loadLocal();

      const results = registry.search('quantum');
      expect(results.length).toBe(0);
    });
  });

  describe('toAgentDefinition', () => {
    it('should convert skill to agent definition', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      registry.loadLocal();

      const skill = registry.get('test-skill')!;
      const agent = registry.toAgentDefinition(skill);

      expect(agent.id).toBe('skill:test-skill');
      expect(agent.role).toBe('A test skill for unit tests');
      expect(agent.instructions).toContain('Test Skill');
      expect(agent.allowedTools).toEqual(['file_read', 'shell_exec']);
    });
  });

  describe('validate', () => {
    it('should validate a valid skill', () => {
      writeFileSync(join(TEST_DIR, 'test-skill.md'), SAMPLE_SKILL);
      registry.loadLocal();

      const skill = registry.get('test-skill')!;
      const result = registry.validate(skill);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should catch invalid skill name', () => {
      const result = registry.validate({
        name: 'Invalid Name!',
        version: '1.0.0',
        description: 'test',
        author: 'test',
        instructions: 'test',
        source: 'local',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('kebab-case'))).toBe(true);
    });

    it('should catch missing required fields', () => {
      const result = registry.validate({
        name: '',
        version: '',
        description: '',
        author: '',
        instructions: '',
        source: 'local',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('scaffold', () => {
    it('should generate valid skill markdown', () => {
      const markdown = registry.scaffold('my-new-skill', 'Does amazing things');
      expect(markdown).toContain('name: my-new-skill');
      expect(markdown).toContain('description: Does amazing things');
      expect(markdown).toContain('version: 1.0.0');
    });
  });
});
