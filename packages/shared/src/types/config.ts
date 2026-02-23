import type { BudgetPresetName, BudgetEnvelope } from './budget.js';
import type { ModelProviderName } from './model.js';
import type { EnergyConfig } from './energy.js';
import type { AuthConfig } from './auth.js';
import type { PluginConfig } from './plugin.js';
import type { ScheduleConfig } from './scheduler.js';
import type { VoiceConfig } from './voice.js';
import type { Constitution } from './constitution.js';

export interface ChannelsConfig {
  slack?: {
    botToken: string;
    appToken: string;
    signingSecret?: string;
    allowedChannels?: string[];
    budgetPreset?: string;
  };
  discord?: {
    botToken: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
    budgetPreset?: string;
  };
  telegram?: {
    botToken: string;
    allowedChats?: string[];
    budgetPreset?: string;
  };
  whatsapp?: {
    allowedNumbers?: string[];
    budgetPreset?: string;
    sessionDataPath?: string;
  };
  signal?: {
    account: string;
    signalCliPath?: string;
    allowedNumbers?: string[];
    allowGroups?: boolean;
    budgetPreset?: string;
  };
  teams?: {
    appId: string;
    appPassword: string;
    port?: number;
    allowedTenants?: string[];
    budgetPreset?: string;
  };
  email?: {
    imap: { host: string; port?: number; user: string; pass: string; tls?: boolean };
    smtp: { host: string; port?: number; user: string; pass: string; secure?: boolean };
    allowedSenders?: string[];
    pollIntervalMs?: number;
    budgetPreset?: string;
  };
  matrix?: {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    allowedRooms?: string[];
    budgetPreset?: string;
  };
  irc?: {
    server: string;
    port?: number;
    nick: string;
    channels?: string[];
    tls?: boolean;
    requireMention?: boolean;
    budgetPreset?: string;
  };
  twilioSms?: {
    accountSid: string;
    authToken: string;
    phoneNumber: string;
    webhookPort?: number;
    allowedNumbers?: string[];
    budgetPreset?: string;
  };
  webhook?: {
    port?: number;
    path?: string;
    secret?: string;
    budgetPreset?: string;
  };
}

export interface IoTConfig {
  mqttBrokerUrl?: string;
  homeAssistantUrl?: string;
  homeAssistantToken?: string;
}

export interface ProactiveConfig {
  enabled?: boolean;
  tickIntervalMs?: number;
}

export interface OsAutomationConfig {
  screenshotDir?: string;
  commandTimeoutMs?: number;
}

export interface ProvidersConfig {
  ollama?: {
    baseUrl: string;
    models: { slm: string; llm?: string };
    enabled: boolean;
  };
  anthropic?: {
    apiKey: string;
    models: { slm: string; llm: string };
    enabled: boolean;
  };
  openai?: {
    apiKey: string;
    models: { slm: string; llm: string };
    enabled: boolean;
  };
  google?: {
    apiKey: string;
    models: { slm: string; llm: string };
    enabled: boolean;
  };
}

export interface BudgetsConfig {
  default: BudgetPresetName;
  presets: Record<BudgetPresetName, BudgetEnvelope>;
}

export interface ToolsConfig {
  builtinEnabled: boolean;
  pluginDirs: string[];
  disabledTools: string[];
}

export interface RoutingConfig {
  preferLocal: boolean;
  slmConfidenceThreshold: number;
  complexityThreshold: number;
  providerPriority: {
    slm: ModelProviderName[];
    llm: ModelProviderName[];
  };
  preferEfficientModels?: boolean;
  energyWeight?: number;
  maxReplanDepth?: number;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  traceOutput: 'memory' | 'file' | 'both';
  traceDir?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  apiKey?: string;
}

export interface McpServerConfigEntry {
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfigEntry>;
}

export interface BrowserConfig {
  headless?: boolean;
  screenshotDir?: string;
  idleTimeoutMs?: number;
}

export interface JouleConfig {
  providers: ProvidersConfig;
  budgets: BudgetsConfig;
  tools: ToolsConfig;
  routing: RoutingConfig;
  logging: LoggingConfig;
  server: ServerConfig;
  energy?: EnergyConfig;
  mcp?: McpConfig;
  auth?: AuthConfig;
  plugins?: PluginConfig;
  channels?: ChannelsConfig;
  browser?: BrowserConfig;
  schedule?: ScheduleConfig;
  voice?: VoiceConfig;
  iot?: IoTConfig;
  proactive?: ProactiveConfig;
  osAutomation?: OsAutomationConfig;
  constitution?: Constitution;
}
