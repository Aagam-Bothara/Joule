import { z } from 'zod';
import { budgetPresetNameSchema, budgetEnvelopeSchema } from './budget.schema.js';
import { modelProviderNameSchema } from './model.schema.js';
import { energyConfigSchema } from './energy.schema.js';
import { authConfigSchema } from './auth.schema.js';

const ollamaConfigSchema = z.object({
  baseUrl: z.string().url().default('http://localhost:11434'),
  models: z.object({
    slm: z.string().default('llama3.2:3b'),
    llm: z.string().optional(),
  }),
  enabled: z.boolean().default(true),
});

const cloudProviderConfigSchema = z.object({
  apiKey: z.string().min(1).optional(),
  models: z.object({
    slm: z.string(),
    llm: z.string(),
  }),
  enabled: z.boolean().default(true),
});

export const providersConfigSchema = z.object({
  ollama: ollamaConfigSchema.optional(),
  anthropic: cloudProviderConfigSchema.optional(),
  openai: cloudProviderConfigSchema.optional(),
  google: cloudProviderConfigSchema.optional(),
});

export const budgetsConfigSchema = z.object({
  default: budgetPresetNameSchema.default('medium'),
  presets: z.record(budgetPresetNameSchema, budgetEnvelopeSchema).optional(),
});

export const toolsConfigSchema = z.object({
  builtinEnabled: z.boolean().default(true),
  pluginDirs: z.array(z.string()).default([]),
  disabledTools: z.array(z.string()).default([]),
});

export const routingConfigSchema = z.object({
  preferLocal: z.boolean().default(true),
  slmConfidenceThreshold: z.number().min(0).max(1).default(0.6),
  complexityThreshold: z.number().min(0).max(1).default(0.7),
  providerPriority: z.object({
    slm: z.array(modelProviderNameSchema).default(['ollama', 'google', 'openai', 'anthropic']),
    llm: z.array(modelProviderNameSchema).default(['anthropic', 'openai', 'google']),
  }).default({}),
  preferEfficientModels: z.boolean().default(false).optional(),
  energyWeight: z.number().min(0).max(1).default(0).optional(),
  maxReplanDepth: z.number().int().min(0).max(10).default(2).optional(),
});

export const loggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  traceOutput: z.enum(['memory', 'file', 'both']).default('memory'),
  traceDir: z.string().optional(),
});

export const serverConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3927),
  host: z.string().default('127.0.0.1'),
  apiKey: z.string().optional(),
});

export const mcpServerConfigSchema = z.object({
  transport: z.enum(['stdio', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean().default(true).optional(),
});

export const mcpConfigSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigSchema).default({}),
});

export const pluginConfigSchema = z.object({
  pluginsDir: z.string().optional(),
  autoUpdate: z.boolean().default(false).optional(),
  registry: z.string().url().optional(),
});

export const channelsConfigSchema = z.object({
  slack: z.object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    signingSecret: z.string().optional(),
    allowedChannels: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  discord: z.object({
    botToken: z.string().min(1),
    allowedGuilds: z.array(z.string()).optional(),
    allowedChannels: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  telegram: z.object({
    botToken: z.string().min(1),
    allowedChats: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  whatsapp: z.object({
    allowedNumbers: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
    sessionDataPath: z.string().optional(),
  }).optional(),
  signal: z.object({
    account: z.string().min(1),
    signalCliPath: z.string().optional(),
    allowedNumbers: z.array(z.string()).optional(),
    allowGroups: z.boolean().default(false).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  teams: z.object({
    appId: z.string().min(1),
    appPassword: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(3978).optional(),
    allowedTenants: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  email: z.object({
    imap: z.object({
      host: z.string().min(1),
      port: z.number().int().default(993).optional(),
      user: z.string().min(1),
      pass: z.string().min(1),
      tls: z.boolean().default(true).optional(),
    }),
    smtp: z.object({
      host: z.string().min(1),
      port: z.number().int().default(587).optional(),
      user: z.string().min(1),
      pass: z.string().min(1),
      secure: z.boolean().default(false).optional(),
    }),
    allowedSenders: z.array(z.string()).optional(),
    pollIntervalMs: z.number().int().min(5000).default(30000).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  matrix: z.object({
    homeserverUrl: z.string().url(),
    accessToken: z.string().min(1),
    userId: z.string().min(1),
    allowedRooms: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  irc: z.object({
    server: z.string().min(1),
    port: z.number().int().default(6667).optional(),
    nick: z.string().min(1),
    channels: z.array(z.string()).optional(),
    tls: z.boolean().default(false).optional(),
    requireMention: z.boolean().default(false).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  twilioSms: z.object({
    accountSid: z.string().min(1),
    authToken: z.string().min(1),
    phoneNumber: z.string().min(1),
    webhookPort: z.number().int().min(1).max(65535).default(3080).optional(),
    allowedNumbers: z.array(z.string()).optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
  webhook: z.object({
    port: z.number().int().min(1).max(65535).default(3081).optional(),
    path: z.string().default('/webhook').optional(),
    secret: z.string().optional(),
    budgetPreset: z.string().default('medium').optional(),
  }).optional(),
});

export const osAutomationConfigSchema = z.object({
  screenshotDir: z.string().default('.joule/screenshots').optional(),
  commandTimeoutMs: z.number().int().min(1000).default(15_000).optional(),
});

export const browserConfigSchema = z.object({
  headless: z.boolean().default(true).optional(),
  screenshotDir: z.string().default('.joule/screenshots').optional(),
  idleTimeoutMs: z.number().int().min(10_000).default(300_000).optional(),
});

export const scheduleConfigSchema = z.object({
  enabled: z.boolean().default(false).optional(),
  scheduleFile: z.string().default('.joule/schedules.json').optional(),
  maxConcurrent: z.number().int().min(1).max(10).default(3).optional(),
  telemetryEnabled: z.boolean().default(true).optional(),
});

export const voiceConfigSchema = z.object({
  enabled: z.boolean().default(false).optional(),
  wakeWord: z.string().default('hey joule').optional(),
  sttProvider: z.enum(['ollama', 'openai', 'local', 'windows']).default('ollama').optional(),
  ttsProvider: z.enum(['system', 'elevenlabs', 'none']).default('system').optional(),
  elevenLabsApiKey: z.string().optional(),
  elevenLabsVoiceId: z.string().optional(),
  silenceThresholdMs: z.number().int().min(500).default(1500).optional(),
  sampleRate: z.number().int().default(16000).optional(),
  ollamaUrl: z.string().url().optional(),
  openaiApiKey: z.string().optional(),
});

export const jouleConfigSchema = z.object({
  providers: providersConfigSchema.default({}),
  budgets: budgetsConfigSchema.default({}),
  tools: toolsConfigSchema.default({}),
  routing: routingConfigSchema.default({}),
  logging: loggingConfigSchema.default({}),
  server: serverConfigSchema.default({}),
  energy: energyConfigSchema.optional(),
  mcp: mcpConfigSchema.optional(),
  auth: authConfigSchema.optional(),
  plugins: pluginConfigSchema.optional(),
  channels: channelsConfigSchema.optional(),
  browser: browserConfigSchema.optional(),
  schedule: scheduleConfigSchema.optional(),
  voice: voiceConfigSchema.optional(),
  iot: z.object({
    mqttBrokerUrl: z.string().default('mqtt://localhost:1883').optional(),
    homeAssistantUrl: z.string().url().optional(),
    homeAssistantToken: z.string().optional(),
  }).optional(),
  osAutomation: osAutomationConfigSchema.optional(),
  proactive: z.object({
    enabled: z.boolean().default(false).optional(),
    tickIntervalMs: z.number().int().min(10_000).default(60_000).optional(),
  }).optional(),
});
