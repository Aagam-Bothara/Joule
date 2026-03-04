import { describe, it, expect } from 'vitest';
import {
  CREW_TEMPLATES,
  CODE_REVIEW_CREW,
  RESEARCH_CREW,
  CONTENT_CREW,
  getCrewTemplate,
  listCrewTemplates,
} from '../src/crew-templates.js';

describe('Crew Templates', () => {
  describe('CODE_REVIEW_CREW', () => {
    it('should have correct structure', () => {
      expect(CODE_REVIEW_CREW.name).toBe('code-review');
      expect(CODE_REVIEW_CREW.strategy).toBe('parallel');
      expect(CODE_REVIEW_CREW.agents).toHaveLength(3);
    });

    it('should have reviewer, security-checker, and style-checker agents', () => {
      const ids = CODE_REVIEW_CREW.agents.map(a => a.id);
      expect(ids).toContain('reviewer');
      expect(ids).toContain('security-checker');
      expect(ids).toContain('style-checker');
    });

    it('should have budget shares that sum to 1.0', () => {
      const totalShare = CODE_REVIEW_CREW.agents
        .reduce((sum, a) => sum + (a.budgetShare ?? 0), 0);
      expect(totalShare).toBeCloseTo(1.0);
    });

    it('should use direct execution mode', () => {
      for (const agent of CODE_REVIEW_CREW.agents) {
        expect(agent.executionMode).toBe('direct');
      }
    });
  });

  describe('RESEARCH_CREW', () => {
    it('should have correct structure', () => {
      expect(RESEARCH_CREW.name).toBe('research');
      expect(RESEARCH_CREW.strategy).toBe('sequential');
      expect(RESEARCH_CREW.agents).toHaveLength(3);
    });

    it('should have researcher, fact-checker, and synthesizer agents', () => {
      const ids = RESEARCH_CREW.agents.map(a => a.id);
      expect(ids).toContain('researcher');
      expect(ids).toContain('fact-checker');
      expect(ids).toContain('synthesizer');
    });

    it('should have correct execution order', () => {
      expect(RESEARCH_CREW.agentOrder).toEqual(['researcher', 'fact-checker', 'synthesizer']);
    });

    it('should use last aggregation (synthesizer output)', () => {
      expect(RESEARCH_CREW.aggregation).toBe('last');
    });
  });

  describe('CONTENT_CREW', () => {
    it('should have correct structure', () => {
      expect(CONTENT_CREW.name).toBe('content');
      expect(CONTENT_CREW.strategy).toBe('sequential');
      expect(CONTENT_CREW.agents).toHaveLength(3);
    });

    it('should have writer, editor, and seo-optimizer agents', () => {
      const ids = CONTENT_CREW.agents.map(a => a.id);
      expect(ids).toContain('writer');
      expect(ids).toContain('editor');
      expect(ids).toContain('seo-optimizer');
    });

    it('should have correct execution order', () => {
      expect(CONTENT_CREW.agentOrder).toEqual(['writer', 'editor', 'seo-optimizer']);
    });
  });

  describe('CREW_TEMPLATES registry', () => {
    it('should contain all three templates', () => {
      expect(Object.keys(CREW_TEMPLATES)).toHaveLength(3);
      expect(CREW_TEMPLATES['code-review']).toBeDefined();
      expect(CREW_TEMPLATES['research']).toBeDefined();
      expect(CREW_TEMPLATES['content']).toBeDefined();
    });
  });

  describe('getCrewTemplate', () => {
    it('should return a template by name', () => {
      const template = getCrewTemplate('code-review');
      expect(template).toBeDefined();
      expect(template!.name).toBe('code-review');
    });

    it('should return undefined for unknown template', () => {
      const template = getCrewTemplate('nonexistent');
      expect(template).toBeUndefined();
    });

    it('should apply overrides', () => {
      const template = getCrewTemplate('research', {
        budget: 'low',
        aggregation: 'concat',
      });
      expect(template).toBeDefined();
      expect(template!.budget).toBe('low');
      expect(template!.aggregation).toBe('concat');
      // Original agents preserved
      expect(template!.agents).toHaveLength(3);
    });

    it('should allow overriding agents', () => {
      const template = getCrewTemplate('content', {
        agents: [{ id: 'solo', role: 'Writer', instructions: 'Write', executionMode: 'direct' }],
      });
      expect(template!.agents).toHaveLength(1);
      expect(template!.agents[0].id).toBe('solo');
    });
  });

  describe('listCrewTemplates', () => {
    it('should list all templates with metadata', () => {
      const list = listCrewTemplates();
      expect(list).toHaveLength(3);

      const names = list.map(t => t.name);
      expect(names).toContain('code-review');
      expect(names).toContain('research');
      expect(names).toContain('content');

      for (const item of list) {
        expect(item.description).toBeTruthy();
        expect(item.strategy).toBeTruthy();
        expect(item.agentCount).toBeGreaterThanOrEqual(3);
      }
    });
  });
});
