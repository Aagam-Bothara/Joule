/**
 * Template Library (P2)
 *
 * 12 templates covering the most common structured task patterns.
 * Template execution skips planning entirely — match keywords → run prompt → done.
 *
 * Energy: ~0.0002 Wh vs ~0.001 Wh for full planned execution (5x cheaper).
 */

import type { TaskTemplate } from '@joule/shared';

export const TEMPLATE_LIBRARY: Record<string, TaskTemplate> = {
  // ── CODE ─────────────────────────────────────────────────────────────────
  write_function: {
    key: 'write_function',
    name: 'Write Function',
    triggerKeywords: ['write a function', 'implement a function', 'create a function', 'build a function', 'write code to'],
    categories: ['code_generation'],
    promptTemplate: `Write a {language} function that {description}.
Return ONLY the code with a brief docstring. No explanation outside the code.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.0002,
  },

  debug_code: {
    key: 'debug_code',
    name: 'Debug Code',
    triggerKeywords: ['fix this code', 'debug this', 'there is a bug', 'not working', 'error in my code', 'fix the bug'],
    categories: ['code_generation'],
    promptTemplate: `Fix the following code.

Code:
{code}

Error: {error}

Return ONLY the corrected code with a brief comment explaining the fix.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.0002,
  },

  write_tests: {
    key: 'write_tests',
    name: 'Write Tests',
    triggerKeywords: ['write tests', 'write unit tests', 'add tests', 'test this function', 'write test cases'],
    categories: ['code_generation'],
    promptTemplate: `Write unit tests for the following {language} code using {framework}.

Code:
{code}

Return ONLY the test code. Cover happy path, edge cases, and error cases.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.0002,
  },

  explain_code: {
    key: 'explain_code',
    name: 'Explain Code',
    triggerKeywords: ['explain this code', 'what does this code do', 'how does this work', 'explain the following'],
    categories: ['code_generation', 'qa'],
    promptTemplate: `Explain the following code clearly and concisely.

Code:
{code}

Provide: (1) what it does, (2) how it works, (3) any important gotchas.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.00015,
  },

  // ── SUMMARIZATION ────────────────────────────────────────────────────────
  summarize_document: {
    key: 'summarize_document',
    name: 'Summarize Document',
    triggerKeywords: ['summarize this', 'summarize the following', 'give me a summary', 'tldr', 'brief summary'],
    categories: ['summarization'],
    promptTemplate: `Summarize the following text in 3-5 sentences. Focus on the key points and main conclusions.

Text:
{description}`,
    chunkPrompt: `Summarize this section in 2-3 sentences, focusing on key points:

{chunk}`,
    combinePrompt: `Combine these section summaries into one coherent 3-5 sentence summary:

{summaries}`,
    chunkSize: 500,
    modelTier: 'slm',
    estimatedEnergyWh: 0.0003,
  },

  extract_keypoints: {
    key: 'extract_keypoints',
    name: 'Extract Key Points',
    triggerKeywords: ['extract key points', 'list the main points', 'bullet points from', 'key takeaways', 'main ideas'],
    categories: ['summarization', 'research'],
    promptTemplate: `Extract the key points from the following text as a bulleted list. Be concise and specific.

Text:
{description}`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.00015,
  },

  // ── WRITING ──────────────────────────────────────────────────────────────
  write_email: {
    key: 'write_email',
    name: 'Write Email',
    triggerKeywords: ['write an email', 'draft an email', 'compose an email', 'write a message to'],
    categories: ['multi_step'],
    promptTemplate: `Write a professional email with the following details:
{description}

Format: Subject line, then email body. Keep it concise and professional.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.00015,
  },

  write_report: {
    key: 'write_report',
    name: 'Write Report',
    triggerKeywords: ['write a report', 'create a report', 'generate a report', 'write a document'],
    categories: ['multi_step'],
    promptTemplate: `Write a structured report on the following topic:
{description}

Include: Executive Summary, Key Findings, Recommendations. Keep it professional and concise.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.0003,
  },

  // ── DATA / ANALYSIS ──────────────────────────────────────────────────────
  analyze_data: {
    key: 'analyze_data',
    name: 'Analyze Data',
    triggerKeywords: ['analyze this data', 'analyze the following data', 'what does this data show', 'insights from this data'],
    categories: ['research'],
    promptTemplate: `Analyze the following data and provide insights:

{description}

Include: (1) Key patterns/trends, (2) Notable outliers, (3) Actionable conclusions.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.0002,
  },

  compare_options: {
    key: 'compare_options',
    name: 'Compare Options',
    triggerKeywords: ['compare', 'what is the difference between', 'difference between', 'pros and cons', 'vs'],
    categories: ['qa', 'research'],
    promptTemplate: `Compare the following options objectively:
{description}

Provide a structured comparison with: key differences, pros/cons for each, and a recommendation.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.00015,
  },

  // ── QA ───────────────────────────────────────────────────────────────────
  factual_lookup: {
    key: 'factual_lookup',
    name: 'Factual Lookup',
    triggerKeywords: ['what is', 'who is', 'when did', 'how many', 'what are', 'define', 'explain what'],
    categories: ['qa'],
    promptTemplate: `Answer the following question accurately and concisely:
{description}

Provide a direct answer followed by a brief explanation if helpful.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.00008,
  },

  translate_text: {
    key: 'translate_text',
    name: 'Translate Text',
    triggerKeywords: ['translate', 'translate this to', 'translate into', 'in spanish', 'in french', 'in german'],
    categories: ['multi_step'],
    promptTemplate: `Translate the following text to {language}:

{description}

Return ONLY the translation.`,
    modelTier: 'slm',
    estimatedEnergyWh: 0.00010,
  },
};

export const TEMPLATE_KEYS = Object.keys(TEMPLATE_LIBRARY);

/**
 * Find the best matching template for a task description.
 * Returns null if no template scores above the threshold.
 */
export function matchTemplate(description: string, minScore = 1): TaskTemplate | null {
  const lower = description.toLowerCase();
  let bestTemplate: TaskTemplate | null = null;
  let bestScore = 0;

  for (const template of Object.values(TEMPLATE_LIBRARY)) {
    let score = 0;
    for (const kw of template.triggerKeywords) {
      if (lower.includes(kw.toLowerCase())) {
        // Longer keyword matches are more specific — weight by length
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestTemplate = template;
    }
  }

  return bestScore >= minScore ? bestTemplate : null;
}

/**
 * Fill a template's promptTemplate with variables extracted from the task description.
 * Simple string interpolation: {description}, {code}, {language}, {error}, {framework}.
 */
export function fillTemplate(template: TaskTemplate, description: string): string {
  // Extract language hint (e.g. "in TypeScript", "using Python")
  const langMatch = description.match(/\b(?:in|using|with)\s+(typescript|javascript|python|go|rust|java|c\+\+|c#|ruby|swift|kotlin)\b/i);
  const language = langMatch?.[1] ?? 'TypeScript';

  // Extract framework hint
  const fwMatch = description.match(/\b(?:using|with)\s+(jest|vitest|pytest|mocha|jasmine|junit|rspec)\b/i);
  const framework = fwMatch?.[1] ?? 'the standard test framework';

  // Extract error message if present (after "Error:" or "error:")
  const errorMatch = description.match(/[Ee]rror[:\s]+(.+?)(?:\n|$)/);
  const error = errorMatch?.[1]?.trim() ?? 'see description';

  // Extract code block if present (```...```)
  const codeMatch = description.match(/```[\w]*\n?([\s\S]+?)```/);
  const code = codeMatch?.[1]?.trim() ?? description;

  return template.promptTemplate
    .replace('{description}', description)
    .replace('{language}', language)
    .replace('{framework}', framework)
    .replace('{error}', error)
    .replace('{code}', code);
}
