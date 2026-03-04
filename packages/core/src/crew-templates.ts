/**
 * Crew Templates — Pre-built agent teams for common jobs.
 *
 * Ready-to-use CrewDefinitions for:
 *  - Code Review: reviewer + security checker + style checker
 *  - Research: researcher + fact checker + synthesizer
 *  - Content: writer + editor + SEO optimizer
 *
 * Each template uses sensible defaults (direct execution, balanced budgets,
 * appropriate tool whitelists) and can be customized via overrides.
 */

import type { CrewDefinition, AgentDefinition } from '@joule/shared';

// ── Code Review Crew ─────────────────────────────────────────────────

const codeReviewAgents: AgentDefinition[] = [
  {
    id: 'reviewer',
    role: 'Code Reviewer',
    instructions: `You are an expert code reviewer. Analyze the provided code for:
- Correctness: logic errors, edge cases, off-by-one errors
- Performance: unnecessary allocations, O(n²) where O(n) suffices
- Readability: naming, structure, comments where logic isn't obvious
- Error handling: missing catches, swallowed errors, unclear error messages

Provide specific, actionable feedback with line references. Be direct — no filler.`,
    allowedTools: ['file_read', 'grep_search', 'shell_exec'],
    budgetShare: 0.4,
    executionMode: 'direct',
    maxRetries: 1,
  },
  {
    id: 'security-checker',
    role: 'Security Analyst',
    instructions: `You are a security-focused code reviewer. Check for:
- OWASP Top 10: injection, XSS, CSRF, broken auth, sensitive data exposure
- Input validation: unsanitized user input, missing bounds checks
- Secrets: hardcoded credentials, API keys, tokens
- Dependencies: known vulnerable patterns
- Access control: missing authorization checks, privilege escalation

Report findings with severity (Critical/High/Medium/Low) and remediation steps.`,
    allowedTools: ['file_read', 'grep_search'],
    budgetShare: 0.3,
    executionMode: 'direct',
    maxRetries: 1,
  },
  {
    id: 'style-checker',
    role: 'Style Guide Enforcer',
    instructions: `You are a code style and consistency checker. Analyze:
- Naming conventions: consistent casing, descriptive names
- File organization: imports ordered, related code grouped
- Type safety: proper TypeScript types, avoid 'any'
- Documentation: public APIs documented, complex logic explained
- Consistency: patterns match rest of codebase

Focus on patterns that affect maintainability, not personal preferences.`,
    allowedTools: ['file_read', 'grep_search'],
    budgetShare: 0.3,
    executionMode: 'direct',
  },
];

export const CODE_REVIEW_CREW: CrewDefinition = {
  name: 'code-review',
  description: 'Three-agent code review: correctness, security, and style',
  agents: codeReviewAgents,
  strategy: 'parallel',
  aggregation: 'concat',
  budget: 'medium',
};

// ── Research Crew ────────────────────────────────────────────────────

const researchAgents: AgentDefinition[] = [
  {
    id: 'researcher',
    role: 'Research Analyst',
    instructions: `You are a thorough research analyst. Given a topic:
1. Break it into key sub-questions
2. Search for relevant information using available tools
3. Gather evidence from multiple sources
4. Note contradictions or gaps in available information
5. Organize findings by sub-topic

Be comprehensive but cite your sources. Distinguish facts from opinions.`,
    allowedTools: ['web_search', 'web_fetch', 'file_read', 'grep_search'],
    budgetShare: 0.4,
    executionMode: 'direct',
    maxRetries: 2,
    maxIterations: 15,
  },
  {
    id: 'fact-checker',
    role: 'Fact Checker',
    instructions: `You are a critical fact-checker. Your job is to:
1. Review the researcher's findings on the blackboard
2. Verify key claims using independent sources
3. Flag any unsubstantiated claims, logical fallacies, or bias
4. Rate confidence level for each major finding (High/Medium/Low)
5. Note where additional verification is needed

Be skeptical but fair. Distinguish between "unverified" and "false".`,
    allowedTools: ['web_search', 'web_fetch'],
    budgetShare: 0.3,
    executionMode: 'direct',
    maxRetries: 1,
  },
  {
    id: 'synthesizer',
    role: 'Report Synthesizer',
    instructions: `You are a report writer. Given the researcher's findings and fact-checker's analysis:
1. Synthesize into a clear, well-structured report
2. Lead with the most important findings
3. Include confidence levels for key claims
4. Flag areas needing further research
5. Provide actionable conclusions

Write in clear, professional prose. Use headers and bullet points for readability.`,
    allowedTools: ['file_write'],
    budgetShare: 0.3,
    executionMode: 'direct',
  },
];

export const RESEARCH_CREW: CrewDefinition = {
  name: 'research',
  description: 'Three-agent research pipeline: gather, verify, synthesize',
  agents: researchAgents,
  strategy: 'sequential',
  agentOrder: ['researcher', 'fact-checker', 'synthesizer'],
  aggregation: 'last',
  budget: 'high',
};

// ── Content Creation Crew ────────────────────────────────────────────

const contentAgents: AgentDefinition[] = [
  {
    id: 'writer',
    role: 'Content Writer',
    instructions: `You are a skilled content writer. Given a topic or brief:
1. Research the subject matter if needed
2. Create an outline with clear structure
3. Write engaging, informative content
4. Use active voice and clear language
5. Include relevant examples and data points

Match the tone to the target audience. Be informative without being boring.`,
    allowedTools: ['web_search', 'web_fetch', 'file_read', 'file_write'],
    budgetShare: 0.4,
    executionMode: 'direct',
    maxRetries: 1,
  },
  {
    id: 'editor',
    role: 'Content Editor',
    instructions: `You are a professional editor. Review the writer's content for:
1. Clarity: remove jargon, simplify complex sentences
2. Flow: ensure logical progression between paragraphs
3. Grammar: fix errors, improve sentence structure
4. Tone: consistent voice throughout
5. Completeness: all key points covered, no gaps

Provide the edited version directly. Don't just list issues — fix them.`,
    allowedTools: ['file_read', 'file_write'],
    budgetShare: 0.3,
    executionMode: 'direct',
  },
  {
    id: 'seo-optimizer',
    role: 'SEO Optimizer',
    instructions: `You are an SEO specialist. Optimize the content for search:
1. Identify target keywords from the topic
2. Ensure keywords appear naturally in headings and body
3. Suggest meta title and description
4. Check heading hierarchy (H1 → H2 → H3)
5. Recommend internal/external link opportunities

Output the final optimized content with SEO metadata at the top.`,
    allowedTools: ['file_read', 'file_write'],
    budgetShare: 0.3,
    executionMode: 'direct',
  },
];

export const CONTENT_CREW: CrewDefinition = {
  name: 'content',
  description: 'Three-agent content pipeline: write, edit, SEO optimize',
  agents: contentAgents,
  strategy: 'sequential',
  agentOrder: ['writer', 'editor', 'seo-optimizer'],
  aggregation: 'last',
  budget: 'medium',
};

// ── Template Registry ────────────────────────────────────────────────

export const CREW_TEMPLATES: Record<string, CrewDefinition> = {
  'code-review': CODE_REVIEW_CREW,
  'research': RESEARCH_CREW,
  'content': CONTENT_CREW,
};

/**
 * Get a crew template by name, optionally with overrides.
 */
export function getCrewTemplate(
  name: string,
  overrides?: Partial<CrewDefinition>,
): CrewDefinition | undefined {
  const template = CREW_TEMPLATES[name];
  if (!template) return undefined;

  if (!overrides) return { ...template };

  return {
    ...template,
    ...overrides,
    agents: overrides.agents ?? template.agents,
  };
}

/**
 * List all available crew template names and descriptions.
 */
export function listCrewTemplates(): Array<{ name: string; description: string; strategy: string; agentCount: number }> {
  return Object.values(CREW_TEMPLATES).map(t => ({
    name: t.name,
    description: t.description ?? '',
    strategy: t.strategy,
    agentCount: t.agents.length,
  }));
}
