/**
 * Simple Mode API — zero-config one-liner to run Joule tasks.
 *
 * Usage:
 *   import { Joule } from '@joule/core';
 *   const result = await Joule.simple("summarize this document");
 *
 * Auto-detects provider from environment variables:
 *   JOULE_ANTHROPIC_API_KEY, JOULE_OPENAI_API_KEY, JOULE_GOOGLE_API_KEY
 *   Falls back to Ollama at localhost:11434 if no API keys found.
 */

import { generateId, type Task, type JouleConfig, type BudgetPresetName, BUDGET_PRESETS } from '@joule/shared';
import type { StreamEvent } from './task-executor.js';
import { Joule } from './engine.js';
import {
  OllamaProvider,
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
} from '@joule/models';
import {
  fileReadTool,
  fileWriteTool,
  shellExecTool,
  httpFetchTool,
  jsonTransformTool,
} from '@joule/tools';

export interface SimpleOptions {
  /** Budget preset (default: 'medium') */
  budget?: BudgetPresetName;
  /** Force a specific provider instead of auto-detecting */
  provider?: 'anthropic' | 'openai' | 'google' | 'ollama';
  /** Enable governance (default: false) */
  governance?: boolean;
  /** Additional config overrides merged on top of simple defaults */
  configOverrides?: Partial<JouleConfig>;
}

/** Build the config overrides for simple mode */
function buildSimpleConfig(options?: SimpleOptions): Partial<JouleConfig> {
  const budget = options?.budget ?? 'medium';

  const base: Partial<JouleConfig> = {
    budgets: { default: budget, presets: BUDGET_PRESETS },
    tools: { builtinEnabled: true, pluginDirs: [], disabledTools: [] },
    logging: { level: 'warn', traceOutput: 'memory' },
    routing: {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: {
        slm: ['ollama', 'google', 'openai', 'anthropic'],
        llm: ['anthropic', 'openai', 'google'],
      },
    },
    server: { port: 3927, host: '127.0.0.1' },
  };

  if (options?.configOverrides) {
    return { ...base, ...options.configOverrides };
  }

  return base;
}

/** Auto-register providers from env vars and register core tools */
function autoSetup(joule: Joule, options?: SimpleOptions): void {
  const forced = options?.provider;

  // Provider registration — forced or auto-detect from env vars
  const anthropicKey = process.env.JOULE_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.JOULE_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  const googleKey = process.env.JOULE_GOOGLE_API_KEY ?? process.env.GOOGLE_API_KEY;

  if (forced === 'anthropic' || (!forced && anthropicKey)) {
    if (anthropicKey) {
      joule.providers.register(new AnthropicProvider({
        apiKey: anthropicKey,
        slmModel: 'claude-haiku-4-5-20251001',
        llmModel: 'claude-sonnet-4-20250514',
      }));
    }
  }

  if (forced === 'openai' || (!forced && openaiKey)) {
    if (openaiKey) {
      joule.providers.register(new OpenAIProvider({
        apiKey: openaiKey,
        slmModel: 'gpt-4o-mini',
        llmModel: 'gpt-4o',
      }));
    }
  }

  if (forced === 'google' || (!forced && googleKey)) {
    if (googleKey) {
      joule.providers.register(new GoogleProvider({
        apiKey: googleKey,
        slmModel: 'gemini-2.0-flash',
        llmModel: 'gemini-2.5-pro',
      }));
    }
  }

  // Fallback to Ollama if no cloud provider was registered
  const hasCloudProvider = (forced === 'anthropic' && anthropicKey) ||
    (forced === 'openai' && openaiKey) ||
    (forced === 'google' && googleKey) ||
    (!forced && (anthropicKey || openaiKey || googleKey));
  if (forced === 'ollama' || !hasCloudProvider) {
    joule.providers.register(new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2:3b',
    }));
  }

  // Register core tools only (safe, universal)
  joule.tools.register(fileReadTool, 'builtin');
  joule.tools.register(fileWriteTool, 'builtin');
  joule.tools.register(shellExecTool, 'builtin');
  joule.tools.register(httpFetchTool, 'builtin');
  joule.tools.register(jsonTransformTool, 'builtin');
}

/**
 * Execute a task with zero configuration.
 * Auto-detects providers from environment variables, uses sensible defaults.
 *
 * @example
 * ```typescript
 * const result = await simple("What is 2+2?");
 * console.log(result); // "4"
 * ```
 */
export async function simple(description: string, options?: SimpleOptions): Promise<string> {
  const configOverrides = buildSimpleConfig(options);
  const joule = new Joule(configOverrides);

  autoSetup(joule, options);
  await joule.initialize();

  try {
    const task: Task = {
      id: generateId('task'),
      description,
      budget: options?.budget ?? 'medium',
      createdAt: new Date().toISOString(),
    };

    const result = await joule.execute(task);
    return result.result ?? '';
  } finally {
    await joule.shutdown();
  }
}

/**
 * Stream a task execution with zero configuration.
 * Auto-detects providers from environment variables, uses sensible defaults.
 *
 * @example
 * ```typescript
 * for await (const event of simpleStream("Write a poem")) {
 *   if (event.chunk) process.stdout.write(event.chunk.text ?? '');
 * }
 * ```
 */
export async function* simpleStream(
  description: string,
  options?: SimpleOptions,
): AsyncGenerator<StreamEvent> {
  const configOverrides = buildSimpleConfig(options);
  const joule = new Joule(configOverrides);

  autoSetup(joule, options);
  await joule.initialize();

  try {
    const task: Task = {
      id: generateId('task'),
      description,
      budget: options?.budget ?? 'medium',
      createdAt: new Date().toISOString(),
    };

    yield* joule.executeStream(task);
  } finally {
    await joule.shutdown();
  }
}
