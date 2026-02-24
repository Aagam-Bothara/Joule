import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { JouleUser, ApiKey, MonthlyBudgetQuota } from '@joule/shared';
import { generateId } from '@joule/shared';
import type { UserRepository, UserData } from '@joule/store';

const DEFAULT_QUOTA: MonthlyBudgetQuota = {
  maxTokens: 1_000_000,
  maxCostUsd: 10.0,
  maxEnergyWh: 1.0,
  tokensUsed: 0,
  costUsed: 0,
  energyUsed: 0,
  periodStart: new Date().toISOString(),
};

export class UserStore {
  private users: Map<string, JouleUser> = new Map();
  private usernameIndex: Map<string, string> = new Map(); // username -> id
  private apiKeyIndex: Map<string, string> = new Map(); // key -> userId
  private repo?: UserRepository;

  constructor(private filePath: string, userRepo?: UserRepository) {
    this.repo = userRepo;
  }

  async load(): Promise<void> {
    if (this.repo) {
      const allUsers = this.repo.list();
      this.users.clear();
      this.usernameIndex.clear();
      this.apiKeyIndex.clear();

      for (const userData of allUsers) {
        const user = this.fromUserData(userData);
        this.users.set(user.id, user);
        this.usernameIndex.set(user.username, user.id);
        for (const key of user.apiKeys) {
          this.apiKeyIndex.set(key.key, user.id);
        }
      }
      return;
    }

    if (!existsSync(this.filePath)) return;

    const data = JSON.parse(await readFile(this.filePath, 'utf-8'));
    const users: JouleUser[] = data.users ?? [];

    this.users.clear();
    this.usernameIndex.clear();
    this.apiKeyIndex.clear();

    for (const user of users) {
      this.users.set(user.id, user);
      this.usernameIndex.set(user.username, user.id);
      for (const key of user.apiKeys) {
        this.apiKeyIndex.set(key.key, user.id);
      }
    }
  }

  private async save(): Promise<void> {
    if (this.repo) {
      for (const user of this.users.values()) {
        this.repo.save(this.toUserData(user));
      }
      return;
    }

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const users = Array.from(this.users.values());
    await writeFile(this.filePath, JSON.stringify({ users }, null, 2), 'utf-8');
  }

  private toUserData(user: JouleUser): UserData {
    return {
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash,
      role: user.role,
      createdAt: user.createdAt,
      quota: {
        maxTokens: user.quota.maxTokens,
        maxCostUsd: user.quota.maxCostUsd,
        maxEnergyWh: user.quota.maxEnergyWh,
        tokensUsed: user.quota.tokensUsed,
        costUsed: user.quota.costUsed,
        energyUsed: user.quota.energyUsed,
        periodStart: user.quota.periodStart,
      },
      apiKeys: user.apiKeys.map(k => ({
        id: k.id,
        key: k.key,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
    };
  }

  private fromUserData(data: UserData): JouleUser {
    return {
      id: data.id,
      username: data.username,
      passwordHash: data.passwordHash,
      role: data.role as 'user' | 'admin',
      createdAt: data.createdAt,
      apiKeys: data.apiKeys.map(k => ({
        id: k.id,
        key: k.key,
        name: k.name,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      })),
      quota: {
        maxTokens: data.quota.maxTokens,
        maxCostUsd: data.quota.maxCostUsd,
        maxEnergyWh: data.quota.maxEnergyWh,
        tokensUsed: data.quota.tokensUsed,
        costUsed: data.quota.costUsed,
        energyUsed: data.quota.energyUsed,
        periodStart: data.quota.periodStart,
      },
    };
  }

  static hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = createHash('sha256').update(salt + password).digest('hex');
    return `${salt}:${hash}`;
  }

  static verifyPassword(password: string, passwordHash: string): boolean {
    const [salt, hash] = passwordHash.split(':');
    const computed = createHash('sha256').update(salt + password).digest('hex');
    return computed === hash;
  }

  async createUser(username: string, password: string, role: 'user' | 'admin' = 'user'): Promise<JouleUser> {
    if (this.usernameIndex.has(username)) {
      throw new Error(`User "${username}" already exists`);
    }

    const user: JouleUser = {
      id: generateId('usr'),
      username,
      passwordHash: UserStore.hashPassword(password),
      role,
      createdAt: new Date().toISOString(),
      apiKeys: [],
      quota: { ...DEFAULT_QUOTA, periodStart: new Date().toISOString() },
    };

    this.users.set(user.id, user);
    this.usernameIndex.set(username, user.id);
    await this.save();
    return user;
  }

  getById(id: string): JouleUser | undefined {
    return this.users.get(id);
  }

  getByUsername(username: string): JouleUser | undefined {
    const id = this.usernameIndex.get(username);
    return id ? this.users.get(id) : undefined;
  }

  getByApiKey(key: string): JouleUser | undefined {
    const userId = this.apiKeyIndex.get(key);
    return userId ? this.users.get(userId) : undefined;
  }

  listUsers(): JouleUser[] {
    return Array.from(this.users.values());
  }

  async deleteUser(id: string): Promise<boolean> {
    const user = this.users.get(id);
    if (!user) return false;

    this.users.delete(id);
    this.usernameIndex.delete(user.username);
    for (const key of user.apiKeys) {
      this.apiKeyIndex.delete(key.key);
    }
    await this.save();
    return true;
  }

  async createApiKey(userId: string, name: string): Promise<ApiKey> {
    const user = this.users.get(userId);
    if (!user) throw new Error('User not found');

    const apiKey: ApiKey = {
      id: generateId('key'),
      key: `jk_${randomBytes(24).toString('hex')}`,
      name,
      createdAt: new Date().toISOString(),
    };

    user.apiKeys.push(apiKey);
    this.apiKeyIndex.set(apiKey.key, userId);
    await this.save();
    return apiKey;
  }

  async deleteApiKey(userId: string, keyId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user) return false;

    const idx = user.apiKeys.findIndex(k => k.id === keyId);
    if (idx === -1) return false;

    const [removed] = user.apiKeys.splice(idx, 1);
    this.apiKeyIndex.delete(removed.key);
    await this.save();
    return true;
  }

  async deductQuota(userId: string, tokens: number, costUsd: number, energyWh: number): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;

    // Reset quota if period expired (monthly)
    const periodStart = new Date(user.quota.periodStart);
    const now = new Date();
    if (now.getMonth() !== periodStart.getMonth() || now.getFullYear() !== periodStart.getFullYear()) {
      user.quota.tokensUsed = 0;
      user.quota.costUsed = 0;
      user.quota.energyUsed = 0;
      user.quota.periodStart = now.toISOString();
    }

    user.quota.tokensUsed += tokens;
    user.quota.costUsed += costUsd;
    user.quota.energyUsed += energyWh;
    await this.save();
  }

  checkQuota(userId: string): { allowed: boolean; reason?: string } {
    const user = this.users.get(userId);
    if (!user) return { allowed: false, reason: 'User not found' };

    const q = user.quota;
    if (q.tokensUsed >= q.maxTokens) return { allowed: false, reason: 'Token quota exceeded' };
    if (q.costUsed >= q.maxCostUsd) return { allowed: false, reason: 'Cost quota exceeded' };
    if (q.energyUsed >= q.maxEnergyWh) return { allowed: false, reason: 'Energy quota exceeded' };

    return { allowed: true };
  }

  async updateApiKeyLastUsed(key: string): Promise<void> {
    const userId = this.apiKeyIndex.get(key);
    if (!userId) return;
    const user = this.users.get(userId);
    if (!user) return;
    const apiKey = user.apiKeys.find(k => k.key === key);
    if (apiKey) {
      apiKey.lastUsedAt = new Date().toISOString();
      await this.save();
    }
  }
}
