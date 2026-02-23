import type { BudgetPresetName } from '@joule/shared';

export interface Attachment {
  type: 'image' | 'document' | 'audio' | 'video' | 'file';
  url?: string;
  data?: string; // base64 encoded
  mimeType: string;
  filename?: string;
  size?: number;
}

export interface ChannelMessage {
  platform: 'slack' | 'discord' | 'telegram' | 'whatsapp' | 'signal' | 'teams' | 'email' | 'matrix' | 'irc' | 'twilio-sms' | 'webhook';
  channelId: string;
  userId: string;
  username: string;
  text: string;
  threadId?: string;
  timestamp: string;
  attachments?: Attachment[];
}

export interface ChannelResponse {
  text: string;
  threadId?: string;
  metadata?: {
    taskId: string;
    energyWh: number;
    carbonGrams: number;
    tokensUsed: number;
    costUsd: number;
    latencyMs: number;
  };
}

export interface SlackChannelConfig {
  botToken: string;
  appToken: string;
  signingSecret?: string;
  allowedChannels?: string[];
  budgetPreset?: BudgetPresetName;
}

export interface DiscordChannelConfig {
  botToken: string;
  allowedGuilds?: string[];
  allowedChannels?: string[];
  budgetPreset?: BudgetPresetName;
}

export interface TelegramChannelConfig {
  botToken: string;
  allowedChats?: string[];
  budgetPreset?: BudgetPresetName;
}

export interface WhatsAppChannelConfig {
  allowedNumbers?: string[];
  budgetPreset?: BudgetPresetName;
  sessionDataPath?: string;
}

export interface SignalChannelConfig {
  account: string;
  signalCliPath?: string;
  allowedNumbers?: string[];
  allowGroups?: boolean;
  budgetPreset?: BudgetPresetName;
}

export interface TeamsChannelConfig {
  appId: string;
  appPassword: string;
  port?: number;
  allowedTenants?: string[];
  budgetPreset?: BudgetPresetName;
}

export interface EmailChannelConfig {
  imap: {
    host: string;
    port?: number;
    user: string;
    pass: string;
    tls?: boolean;
  };
  smtp: {
    host: string;
    port?: number;
    user: string;
    pass: string;
    secure?: boolean;
  };
  allowedSenders?: string[];
  pollIntervalMs?: number;
  budgetPreset?: BudgetPresetName;
}

export interface MatrixChannelConfig {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  allowedRooms?: string[];
  budgetPreset?: BudgetPresetName;
}

export interface IrcChannelConfig {
  server: string;
  port?: number;
  nick: string;
  channels?: string[];
  tls?: boolean;
  requireMention?: boolean;
  budgetPreset?: BudgetPresetName;
}

export interface TwilioSmsChannelConfig {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  webhookPort?: number;
  allowedNumbers?: string[];
  budgetPreset?: BudgetPresetName;
}

export interface WebhookChannelConfig {
  port?: number;
  path?: string;
  secret?: string;
  budgetPreset?: BudgetPresetName;
}

export interface ChannelConfig {
  slack?: SlackChannelConfig;
  discord?: DiscordChannelConfig;
  telegram?: TelegramChannelConfig;
  whatsapp?: WhatsAppChannelConfig;
  signal?: SignalChannelConfig;
  teams?: TeamsChannelConfig;
  email?: EmailChannelConfig;
  matrix?: MatrixChannelConfig;
  irc?: IrcChannelConfig;
  twilioSms?: TwilioSmsChannelConfig;
  webhook?: WebhookChannelConfig;
}
