import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  type JouleConfig,
  DEFAULT_CONFIG,
  jouleConfigSchema,
  ConfigError,
} from '@joule/shared';

export class ConfigManager {
  private config: JouleConfig = DEFAULT_CONFIG;

  async load(options?: { configPath?: string }): Promise<JouleConfig> {
    // 1. Start with defaults
    let merged: Record<string, unknown> = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;

    // 2. Load config file
    const fileConfig = await this.loadConfigFile(options?.configPath);
    if (fileConfig) {
      merged = deepMerge(merged, fileConfig);
    }

    // 3. Load environment variables
    const envConfig = this.loadEnvVars();
    merged = deepMerge(merged, envConfig);

    // 4. Validate
    const result = jouleConfigSchema.safeParse(merged);
    if (!result.success) {
      throw new ConfigError(
        `Invalid configuration: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      );
    }

    this.config = result.data as JouleConfig;
    return this.config;
  }

  get<K extends keyof JouleConfig>(key: K): JouleConfig[K] {
    return this.config[key];
  }

  getAll(): JouleConfig {
    return this.config;
  }

  set(overrides: Partial<JouleConfig>): void {
    this.config = deepMerge(
      structuredClone(this.config) as unknown as Record<string, unknown>,
      overrides as unknown as Record<string, unknown>,
    ) as unknown as JouleConfig;
  }

  private async loadConfigFile(configPath?: string): Promise<Record<string, unknown> | null> {
    if (configPath) {
      if (existsSync(configPath)) {
        return this.parseConfigFile(configPath);
      }
      return null;
    }

    // Search cwd and parent directories (like .gitconfig, eslint, etc.)
    const names = ['joule.config.yaml', 'joule.config.yml', 'joule.config.json'];
    let dir = resolve(process.cwd());

    for (let depth = 0; depth < 10; depth++) {
      for (const name of names) {
        const p = resolve(dir, name);
        if (existsSync(p)) {
          return this.parseConfigFile(p);
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }

    return null;
  }

  private async parseConfigFile(p: string): Promise<Record<string, unknown>> {
    const content = await readFile(p, 'utf-8');
    if (p.endsWith('.json')) {
      return JSON.parse(content);
    }
    return parseYaml(content) as Record<string, unknown>;
  }

  private loadEnvVars(): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    if (process.env.JOULE_ANTHROPIC_API_KEY) {
      config.providers = {
        ...config.providers as Record<string, unknown>,
        anthropic: {
          apiKey: process.env.JOULE_ANTHROPIC_API_KEY,
          enabled: true,
          models: { slm: 'claude-haiku-4-5-20251001', llm: 'claude-sonnet-4-20250514' },
        },
      };
    }

    if (process.env.JOULE_OPENAI_API_KEY) {
      config.providers = {
        ...config.providers as Record<string, unknown>,
        openai: {
          apiKey: process.env.JOULE_OPENAI_API_KEY,
          enabled: true,
          models: { slm: 'gpt-4o-mini', llm: 'gpt-4o' },
        },
      };
    }

    if (process.env.JOULE_GOOGLE_API_KEY) {
      config.providers = {
        ...config.providers as Record<string, unknown>,
        google: {
          apiKey: process.env.JOULE_GOOGLE_API_KEY,
          enabled: true,
          models: { slm: 'gemini-2.0-flash', llm: 'gemini-2.5-pro' },
        },
      };
    }

    if (process.env.JOULE_DEFAULT_BUDGET) {
      config.budgets = { default: process.env.JOULE_DEFAULT_BUDGET };
    }

    if (process.env.JOULE_LOG_LEVEL) {
      config.logging = { level: process.env.JOULE_LOG_LEVEL };
    }

    if (process.env.JOULE_SERVER_PORT) {
      config.server = {
        ...config.server as Record<string, unknown>,
        port: parseInt(process.env.JOULE_SERVER_PORT, 10),
      };
    }

    if (process.env.JOULE_API_KEY) {
      config.server = {
        ...config.server as Record<string, unknown>,
        apiKey: process.env.JOULE_API_KEY,
      };
    }

    if (process.env.JOULE_ENERGY_ENABLED) {
      config.energy = {
        ...config.energy as Record<string, unknown>,
        enabled: process.env.JOULE_ENERGY_ENABLED === 'true',
      };
    }

    if (process.env.JOULE_GRID_CARBON_INTENSITY) {
      config.energy = {
        ...config.energy as Record<string, unknown>,
        gridCarbonIntensity: parseInt(process.env.JOULE_GRID_CARBON_INTENSITY, 10),
      };
    }

    return config;
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
