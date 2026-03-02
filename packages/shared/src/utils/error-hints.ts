/**
 * Maps known Joule errors to human-friendly messages with fix suggestions.
 * Used by CLI commands to print actionable output instead of raw stack traces.
 */

interface ErrorHint {
  title: string;
  suggestions: string[];
}

const HINT_PATTERNS: Array<{ test: (msg: string, name?: string) => boolean; hint: (msg: string) => ErrorHint }> = [
  // Provider / API key issues
  {
    test: (msg) => /provider not available.*ollama/i.test(msg) || /ECONNREFUSED.*11434/i.test(msg),
    hint: () => ({
      title: 'Ollama is not running',
      suggestions: [
        'Start Ollama: ollama serve',
        'Check if Ollama is installed: ollama --version',
        'If using a custom URL, verify providers.ollama.baseUrl in joule.config.yaml',
      ],
    }),
  },
  {
    test: (msg) => /provider not available.*anthropic/i.test(msg) || /anthropic.*401/i.test(msg) || /invalid.*api.*key.*anthropic/i.test(msg),
    hint: () => ({
      title: 'Anthropic provider is not configured',
      suggestions: [
        'Set your API key: export JOULE_ANTHROPIC_API_KEY=sk-ant-...',
        'Or add it to joule.config.yaml under providers.anthropic.apiKey',
        'Get a key at: https://console.anthropic.com/settings/keys',
      ],
    }),
  },
  {
    test: (msg) => /provider not available.*openai/i.test(msg) || /openai.*401/i.test(msg) || /invalid.*api.*key.*openai/i.test(msg),
    hint: () => ({
      title: 'OpenAI provider is not configured',
      suggestions: [
        'Set your API key: export JOULE_OPENAI_API_KEY=sk-...',
        'Or add it to joule.config.yaml under providers.openai.apiKey',
        'Get a key at: https://platform.openai.com/api-keys',
      ],
    }),
  },
  {
    test: (msg) => /provider not available.*google/i.test(msg) || /google.*401/i.test(msg),
    hint: () => ({
      title: 'Google AI provider is not configured',
      suggestions: [
        'Set your API key: export JOULE_GOOGLE_API_KEY=...',
        'Or add it to joule.config.yaml under providers.google.apiKey',
        'Get a key at: https://aistudio.google.com/apikey',
      ],
    }),
  },
  {
    test: (msg) => /no.*provider.*available/i.test(msg) || /no suitable provider/i.test(msg),
    hint: () => ({
      title: 'No AI provider is available',
      suggestions: [
        'Run joule init to configure providers',
        'Or start Ollama locally: ollama serve',
        'Or set a cloud API key: export JOULE_ANTHROPIC_API_KEY=sk-ant-...',
        'Check your setup: joule doctor',
      ],
    }),
  },

  // Budget errors
  {
    test: (_, name) => name === 'BudgetExhaustedError',
    hint: (msg) => ({
      title: `Budget limit reached: ${msg}`,
      suggestions: [
        'Use a higher budget: --budget high',
        'Or --budget unlimited for no limits',
        'Custom budgets can be set in joule.config.yaml under budgets.presets',
      ],
    }),
  },

  // Config errors
  {
    test: (msg) => /configuration error/i.test(msg) || /invalid configuration/i.test(msg),
    hint: (msg) => ({
      title: 'Configuration is invalid',
      suggestions: [
        'Run joule doctor to see what\'s wrong',
        'Regenerate config: joule init --force',
        `Details: ${msg}`,
      ],
    }),
  },
  {
    test: (msg) => /joule\.config\.(yaml|yml|json).*not found/i.test(msg) || /no config file/i.test(msg),
    hint: () => ({
      title: 'No config file found',
      suggestions: [
        'Create one: joule init',
        'Or create joule.config.yaml manually in the project root',
        'Config is searched in the current directory and parent directories',
      ],
    }),
  },

  // Tool errors
  {
    test: (_, name) => name === 'ToolNotFoundError',
    hint: (msg) => ({
      title: msg,
      suggestions: [
        'List available tools: joule tools list',
        'Make sure tools.builtinEnabled is true in config',
        'If this is a plugin tool, check that the plugin is installed',
      ],
    }),
  },
  {
    test: (_, name) => name === 'ToolExecutionError',
    hint: (msg) => ({
      title: msg,
      suggestions: [
        'Check that the tool\'s dependencies are available (e.g., Playwright for browser tools)',
        'For shell_exec failures, verify the command works in your terminal',
        'Some tools need specific OS features (COM automation requires Windows)',
      ],
    }),
  },

  // Network / fetch errors
  {
    test: (msg) => /ECONNREFUSED/i.test(msg),
    hint: (msg) => {
      const portMatch = msg.match(/:(\d+)/);
      return {
        title: `Connection refused${portMatch ? ` on port ${portMatch[1]}` : ''}`,
        suggestions: [
          'Check that the target service is running',
          portMatch?.[1] === '11434' ? 'Start Ollama: ollama serve' : `Verify the service on port ${portMatch?.[1] ?? 'unknown'} is up`,
          'Check firewall settings if connecting to a remote host',
        ],
      };
    },
  },
  {
    test: (msg) => /ENOTFOUND/i.test(msg) || /getaddrinfo/i.test(msg),
    hint: () => ({
      title: 'DNS resolution failed',
      suggestions: [
        'Check your internet connection',
        'Verify the hostname/URL is correct',
        'If using a proxy, check proxy settings',
      ],
    }),
  },
  {
    test: (msg) => /rate.*limit/i.test(msg) || /429/i.test(msg) || /too many requests/i.test(msg),
    hint: () => ({
      title: 'API rate limit hit',
      suggestions: [
        'Wait a minute and try again',
        'Enable response caching in config to reduce API calls: cache.enabled: true',
        'Use a lower budget to reduce request volume',
      ],
    }),
  },

  // Constitution
  {
    test: (_, name) => name === 'ConstitutionViolationError',
    hint: (msg) => ({
      title: msg,
      suggestions: [
        'The agent tried to do something blocked by your safety rules',
        'Review your constitution rules in joule.config.yaml',
        'If this is a false positive, adjust the rule severity or remove it',
      ],
    }),
  },
];

/**
 * Given an error, returns a human-friendly hint with fix suggestions.
 * Returns null if no hint matches (fall back to generic error display).
 */
export function getErrorHint(error: unknown): ErrorHint | null {
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;

  for (const pattern of HINT_PATTERNS) {
    if (pattern.test(msg, name)) {
      return pattern.hint(msg);
    }
  }

  return null;
}

/**
 * Format an error for CLI display. Uses hints when available,
 * falls back to the raw error message otherwise.
 */
export function formatErrorForCli(error: unknown): string {
  const hint = getErrorHint(error);
  const lines: string[] = [];

  if (hint) {
    lines.push(`\n  [ERROR] ${hint.title}`);
    lines.push('');
    for (const suggestion of hint.suggestions) {
      lines.push(`    -> ${suggestion}`);
    }
    lines.push('');
  } else {
    const msg = error instanceof Error ? error.message : String(error);
    lines.push(`\n  [ERROR] ${msg}\n`);
  }

  return lines.join('\n');
}
