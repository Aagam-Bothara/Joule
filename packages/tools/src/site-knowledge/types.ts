/**
 * Site Knowledge — Pre-baked navigation intelligence for common websites.
 *
 * Instead of the agent wasting LLM calls discovering selectors and flows,
 * we inject known-good patterns directly into the agent's context.
 * This is Joule's equivalent of OpenClaw's "skills" system.
 */

/** A CSS selector with fallbacks, ordered by reliability. */
export interface SelectorInfo {
  /** Primary selector (most reliable) */
  primary: string;
  /** Fallback selectors if primary fails */
  fallbacks?: string[];
  /** Human-readable description */
  description: string;
}

/** A common user action on a site with exact steps. */
export interface SiteAction {
  /** Action name (e.g., 'search', 'play_video', 'login') */
  name: string;
  /** Step-by-step instructions for the agent */
  steps: string[];
  /** Required tool names for this action */
  tools: string[];
  /** Known selectors used in this action */
  selectors?: Record<string, SelectorInfo>;
  /** Tips for reliability */
  tips?: string[];
}

/** Knowledge about a specific website or web application. */
export interface SiteKnowledge {
  /** Site identifier (e.g., 'youtube', 'google', 'gmail') */
  id: string;
  /** Display name */
  name: string;
  /** URL patterns that match this site (regex strings) */
  urlPatterns: string[];
  /** Base URL for the site */
  baseUrl: string;
  /** Key page selectors the agent should know */
  selectors: Record<string, SelectorInfo>;
  /** Pre-defined actions with exact steps */
  actions: SiteAction[];
  /** General tips for interacting with this site */
  tips: string[];
  /** Known gotchas and how to handle them */
  gotchas?: string[];
  /** Last verified date */
  lastVerified: string;
}
