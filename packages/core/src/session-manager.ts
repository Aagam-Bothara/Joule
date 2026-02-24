import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type ChatSession,
  type SessionMessage,
  type SessionListEntry,
  type SessionMetadata,
  generateId,
  isoNow,
} from '@joule/shared';
import type { SessionRepository, SessionData } from '@joule/store';

const DEFAULT_SESSIONS_DIR = '.joule/sessions';

export class SessionManager {
  private sessionsDir: string;
  private repo?: SessionRepository;

  constructor(baseDir?: string, sessionRepo?: SessionRepository) {
    this.sessionsDir = baseDir ?? path.join(process.cwd(), DEFAULT_SESSIONS_DIR);
    this.repo = sessionRepo;
  }

  async ensureDir(): Promise<void> {
    if (!this.repo) {
      await fs.mkdir(this.sessionsDir, { recursive: true });
    }
  }

  async create(): Promise<ChatSession> {
    const session: ChatSession = {
      id: generateId('session'),
      createdAt: isoNow(),
      updatedAt: isoNow(),
      messages: [],
      metadata: {
        messageCount: 0,
        totalCostUsd: 0,
        totalEnergyWh: 0,
        totalCarbonGrams: 0,
        totalTokens: 0,
      },
    };

    await this.save(session);
    return session;
  }

  async load(id: string): Promise<ChatSession | null> {
    if (this.repo) {
      const data = this.repo.load(id);
      if (!data) return null;
      return this.fromSessionData(data);
    }

    try {
      const filePath = this.sessionPath(id);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as ChatSession;
    } catch {
      return null;
    }
  }

  async save(session: ChatSession): Promise<void> {
    session.updatedAt = isoNow();

    if (this.repo) {
      this.repo.save(this.toSessionData(session));
      return;
    }

    await this.ensureDir();
    const filePath = this.sessionPath(session.id);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
  }

  async list(): Promise<SessionListEntry[]> {
    if (this.repo) {
      return this.repo.list();
    }

    await this.ensureDir();

    try {
      const files = await fs.readdir(this.sessionsDir);
      const entries: SessionListEntry[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await fs.readFile(path.join(this.sessionsDir, file), 'utf-8');
          const session = JSON.parse(content) as ChatSession;

          const preview = session.messages.length > 0
            ? session.messages[0].content.slice(0, 80)
            : '(empty session)';

          entries.push({
            id: session.id,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.metadata.messageCount,
            preview,
          });
        } catch {
          // Skip corrupt files
        }
      }

      return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    if (this.repo) {
      return this.repo.delete(id);
    }

    try {
      await fs.unlink(this.sessionPath(id));
      return true;
    } catch {
      return false;
    }
  }

  addMessage(session: ChatSession, message: SessionMessage): void {
    session.messages.push(message);
    if (message.role === 'user') {
      session.metadata.messageCount++;
    }
  }

  updateMetadata(session: ChatSession, update: Partial<SessionMetadata>): void {
    if (update.totalCostUsd !== undefined) session.metadata.totalCostUsd += update.totalCostUsd;
    if (update.totalEnergyWh !== undefined) session.metadata.totalEnergyWh += update.totalEnergyWh;
    if (update.totalCarbonGrams !== undefined) session.metadata.totalCarbonGrams += update.totalCarbonGrams;
    if (update.totalTokens !== undefined) session.metadata.totalTokens += update.totalTokens;
  }

  trimHistory(messages: SessionMessage[], maxTokenEstimate: number): SessionMessage[] {
    // Rough estimate: ~4 chars per token
    const charsPerToken = 4;
    const maxChars = maxTokenEstimate * charsPerToken;

    let totalChars = 0;
    const trimmed: SessionMessage[] = [];

    // Keep messages from most recent, working backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgChars = messages[i].content.length;
      if (totalChars + msgChars > maxChars && trimmed.length > 0) {
        break;
      }
      totalChars += msgChars;
      trimmed.unshift(messages[i]);
    }

    return trimmed;
  }

  private sessionPath(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  private toSessionData(session: ChatSession): SessionData {
    return {
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
      metadata: {
        messageCount: session.metadata.messageCount,
        totalCostUsd: session.metadata.totalCostUsd,
        totalEnergyWh: session.metadata.totalEnergyWh,
        totalCarbonGrams: session.metadata.totalCarbonGrams,
        totalTokens: session.metadata.totalTokens,
      },
    };
  }

  private fromSessionData(data: SessionData): ChatSession {
    return {
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      messages: data.messages.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp ?? new Date().toISOString(),
      })),
      metadata: {
        messageCount: data.metadata.messageCount,
        totalCostUsd: data.metadata.totalCostUsd,
        totalEnergyWh: data.metadata.totalEnergyWh,
        totalCarbonGrams: data.metadata.totalCarbonGrams,
        totalTokens: data.metadata.totalTokens,
      },
    };
  }
}
