import type { SiteKnowledge, SiteAction } from './types.js';

// Import all site knowledge modules
import { youtube } from './sites/youtube.js';
import { google } from './sites/google.js';
import { gmail } from './sites/gmail.js';
import { github } from './sites/github.js';
import { twitter } from './sites/twitter.js';
import { linkedin } from './sites/linkedin.js';
import { amazon } from './sites/amazon.js';
import { facebook } from './sites/facebook.js';
import { instagram } from './sites/instagram.js';
import { chatgpt } from './sites/chatgpt.js';
import { reddit } from './sites/reddit.js';
import { wikipedia } from './sites/wikipedia.js';
import { yahoo } from './sites/yahoo.js';

/**
 * SiteKnowledgeRegistry — The "Bible" of common websites.
 *
 * Provides pre-baked navigation intelligence for popular sites.
 * When an agent's task involves a known site, the relevant selectors,
 * actions, and tips are injected directly into the agent's context —
 * eliminating the need for the LLM to discover them through trial and error.
 */
export class SiteKnowledgeRegistry {
  private sites = new Map<string, SiteKnowledge>();

  constructor() {
    // Register all built-in sites
    this.register(youtube);
    this.register(google);
    this.register(gmail);
    this.register(github);
    this.register(twitter);
    this.register(linkedin);
    this.register(amazon);
    this.register(facebook);
    this.register(instagram);
    this.register(chatgpt);
    this.register(reddit);
    this.register(wikipedia);
    this.register(yahoo);
  }

  /** Register a site knowledge entry. */
  register(site: SiteKnowledge): void {
    this.sites.set(site.id, site);
  }

  /** Get knowledge for a specific site by ID. */
  get(id: string): SiteKnowledge | undefined {
    return this.sites.get(id);
  }

  /** List all registered site IDs. */
  listIds(): string[] {
    return Array.from(this.sites.keys());
  }

  /** List all registered sites with basic info. */
  listAll(): Array<{ id: string; name: string; baseUrl: string; actionCount: number }> {
    return Array.from(this.sites.values()).map(s => ({
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      actionCount: s.actions.length,
    }));
  }

  /**
   * Find all matching sites for a given URL or text description.
   * Returns sites whose URL patterns match or whose names appear in the text.
   */
  findRelevant(text: string): SiteKnowledge[] {
    const matches: SiteKnowledge[] = [];
    const lower = text.toLowerCase();

    for (const [, site] of this.sites) {
      // Check URL patterns
      const urlMatch = site.urlPatterns.some(pattern => {
        try {
          return new RegExp(pattern, 'i').test(text);
        } catch {
          return false;
        }
      });

      // Check site name / ID mentions with word boundary matching
      // Prevents "book" matching "facebook" — requires the name to appear as a distinct word
      const nameMatch = this.matchesAsWord(lower, site.id.toLowerCase())
        || this.matchesAsWord(lower, site.name.toLowerCase());

      if (urlMatch || nameMatch) {
        matches.push(site);
      }
    }

    return matches;
  }

  /**
   * Check if a word appears as a standalone word in text (word boundary matching).
   * Prevents substring false positives like "book" matching "facebook".
   */
  private matchesAsWord(text: string, word: string): boolean {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return new RegExp(`(?:^|[\\s,;.!?/"'()\\-])${escaped}(?:$|[\\s,;.!?/"'()\\-])`, 'i').test(text);
    } catch {
      return text.includes(word);
    }
  }

  /**
   * Build a context injection string for the agent's system prompt.
   * This is the key method — turns site knowledge into actionable instructions.
   */
  buildContextForAgent(taskDescription: string, agentInstructions: string): string {
    const combinedText = `${taskDescription} ${agentInstructions}`;
    const relevantSites = this.findRelevant(combinedText);

    if (relevantSites.length === 0) return '';

    const sections: string[] = ['## Site Knowledge (Pre-loaded)'];
    sections.push('The following site-specific knowledge is pre-loaded for you. USE these exact selectors and steps — do NOT guess.');

    for (const site of relevantSites) {
      sections.push(`\n### ${site.name} (${site.baseUrl})`);

      // Key selectors
      sections.push('**Key Selectors:**');
      for (const [name, sel] of Object.entries(site.selectors)) {
        const fallbackStr = sel.fallbacks?.length
          ? ` | Fallbacks: ${sel.fallbacks.join(', ')}`
          : '';
        sections.push(`- ${name}: \`${sel.primary}\` — ${sel.description}${fallbackStr}`);
      }

      // Actions with steps
      if (site.actions.length > 0) {
        sections.push('\n**Pre-defined Actions:**');
        for (const action of site.actions) {
          sections.push(`\n*${action.name}:*`);
          action.steps.forEach((step, i) => {
            sections.push(`  ${i + 1}. ${step}`);
          });
          if (action.tips?.length) {
            sections.push(`  Tips: ${action.tips.join('; ')}`);
          }
        }
      }

      // Tips
      if (site.tips.length > 0) {
        sections.push('\n**Tips:**');
        site.tips.forEach(tip => sections.push(`- ${tip}`));
      }

      // Gotchas
      if (site.gotchas?.length) {
        sections.push('\n**Watch Out:**');
        site.gotchas.forEach(g => sections.push(`- ${g}`));
      }
    }

    return sections.join('\n');
  }
}

/** Singleton instance for the application. */
let _instance: SiteKnowledgeRegistry | undefined;

export function getSiteKnowledgeRegistry(): SiteKnowledgeRegistry {
  if (!_instance) {
    _instance = new SiteKnowledgeRegistry();
  }
  return _instance;
}
