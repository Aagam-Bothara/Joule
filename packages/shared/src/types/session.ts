export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface SessionMetadata {
  messageCount: number;
  totalCostUsd: number;
  totalEnergyWh: number;
  totalCarbonGrams: number;
  totalTokens: number;
}

export interface ChatSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  metadata: SessionMetadata;
}

export interface SessionListEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}
