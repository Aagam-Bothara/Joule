/**
 * Enhanced Init Wizard — 3-question setup: Provider → Use Case → Complexity.
 *
 * Maps user answers to full Joule configuration, including crew templates,
 * budget presets, and governance settings.
 */

import * as readline from 'node:readline';

export interface WizardAnswers {
  provider: 'ollama' | 'anthropic' | 'openai' | 'google';
  apiKey?: string;
  useCase: 'general' | 'code-review' | 'research' | 'content' | 'custom';
  complexity: 'simple' | 'standard' | 'advanced';
}

export interface WizardConfig {
  providers: {
    ollama: boolean;
    anthropic: { enabled: boolean; apiKey?: string };
    openai: { enabled: boolean; apiKey?: string };
    google: { enabled: boolean; apiKey?: string };
  };
  budget: string;
  preferLocal: boolean;
  serverPort: number;
  useCase: string;
  governance: boolean;
}

function ask(rl: readline.Interface, question: string, fallback?: string): Promise<string> {
  const hint = fallback ? ` [${fallback}]` : '';
  return new Promise((res) => {
    rl.question(`${question}${hint}: `, (answer) => {
      res(answer.trim() || fallback || '');
    });
  });
}

/**
 * Validate an API key by checking its format (lightweight, no network call).
 */
export function validateApiKeyFormat(provider: string, key: string): boolean {
  if (!key || key.length < 10) return false;

  switch (provider) {
    case 'anthropic':
      return key.startsWith('sk-ant-');
    case 'openai':
      return key.startsWith('sk-');
    case 'google':
      return key.startsWith('AI') || key.length >= 30;
    default:
      return true;
  }
}

/**
 * Run the 3-question wizard interactively.
 */
export async function runWizard(rl: readline.Interface): Promise<WizardAnswers> {
  console.log('');
  console.log('  Joule Quick Setup');
  console.log('  =================');
  console.log('  3 questions to get you started.\n');

  // ── Q1: Provider ──────────────────────────────────────
  console.log('  1. Which AI provider do you want to use?');
  console.log('');
  console.log('     1. Ollama     — local, free, private (needs Ollama running)');
  console.log('     2. Anthropic  — Claude models (needs API key)');
  console.log('     3. OpenAI     — GPT models (needs API key)');
  console.log('     4. Google     — Gemini models (needs API key)');
  console.log('');
  const providerInput = await ask(rl, '  Choose (1-4)', '1');
  const providerMap: Record<string, WizardAnswers['provider']> = {
    '1': 'ollama', '2': 'anthropic', '3': 'openai', '4': 'google',
    'ollama': 'ollama', 'anthropic': 'anthropic', 'openai': 'openai', 'google': 'google',
  };
  const provider = providerMap[providerInput.toLowerCase()] ?? 'ollama';

  // API key for cloud providers
  let apiKey: string | undefined;
  if (provider !== 'ollama') {
    console.log('');
    apiKey = (await ask(rl, `  ${provider} API key (Enter to skip — set env var later)`)) || undefined;
    if (apiKey) {
      if (validateApiKeyFormat(provider, apiKey)) {
        console.log('  Key format looks good.');
      } else {
        console.log('  Warning: key format looks unusual. Double-check it.');
      }
    }
  }

  // ── Q2: Use Case ──────────────────────────────────────
  console.log('');
  console.log('  2. What will you use Joule for?');
  console.log('');
  console.log('     1. General purpose  — chat, tasks, tools');
  console.log('     2. Code review      — multi-agent PR review crew');
  console.log('     3. Research         — sequential deep research crew');
  console.log('     4. Content creation — writer + editor crew');
  console.log('     5. Custom           — start from scratch');
  console.log('');
  const useCaseInput = await ask(rl, '  Choose (1-5)', '1');
  const useCaseMap: Record<string, WizardAnswers['useCase']> = {
    '1': 'general', '2': 'code-review', '3': 'research', '4': 'content', '5': 'custom',
  };
  const useCase = useCaseMap[useCaseInput] ?? 'general';

  // ── Q3: Complexity ────────────────────────────────────
  console.log('');
  console.log('  3. How much power do you need?');
  console.log('');
  console.log('     1. Simple    — low budget, no governance, quick tasks');
  console.log('     2. Standard  — medium budget, balanced defaults (recommended)');
  console.log('     3. Advanced  — high budget, governance enabled, full observability');
  console.log('');
  const complexityInput = await ask(rl, '  Choose (1-3)', '2');
  const complexityMap: Record<string, WizardAnswers['complexity']> = {
    '1': 'simple', '2': 'standard', '3': 'advanced',
  };
  const complexity = complexityMap[complexityInput] ?? 'standard';

  return { provider, apiKey, useCase, complexity };
}

/**
 * Convert wizard answers to a full WizardConfig for config generation.
 */
export function wizardToConfig(answers: WizardAnswers): WizardConfig {
  const budgetMap: Record<WizardAnswers['complexity'], string> = {
    simple: 'low',
    standard: 'medium',
    advanced: 'high',
  };

  return {
    providers: {
      ollama: answers.provider === 'ollama',
      anthropic: {
        enabled: answers.provider === 'anthropic',
        apiKey: answers.provider === 'anthropic' ? answers.apiKey : undefined,
      },
      openai: {
        enabled: answers.provider === 'openai',
        apiKey: answers.provider === 'openai' ? answers.apiKey : undefined,
      },
      google: {
        enabled: answers.provider === 'google',
        apiKey: answers.provider === 'google' ? answers.apiKey : undefined,
      },
    },
    budget: budgetMap[answers.complexity],
    preferLocal: answers.provider === 'ollama',
    serverPort: 3927,
    useCase: answers.useCase,
    governance: answers.complexity === 'advanced',
  };
}

/**
 * Get crew template name for config comments.
 */
export function getCrewTemplateName(useCase: string): string | null {
  const map: Record<string, string> = {
    'code-review': 'CODE_REVIEW_CREW',
    'research': 'RESEARCH_CREW',
    'content': 'CONTENT_CREW',
  };
  return map[useCase] ?? null;
}
