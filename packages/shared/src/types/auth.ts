export interface ApiKey {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface MonthlyBudgetQuota {
  maxTokens: number;
  maxCostUsd: number;
  maxEnergyWh: number;
  tokensUsed: number;
  costUsed: number;
  energyUsed: number;
  periodStart: string;
}

export type UserRole = 'user' | 'admin';

export interface JouleUser {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  apiKeys: ApiKey[];
  quota: MonthlyBudgetQuota;
}

export interface AuthConfig {
  enabled: boolean;
  jwtSecret: string;
  tokenExpirySeconds: number;
  store: 'file';
}

export interface AuthTokenPayload {
  sub: string;
  username: string;
  role: UserRole;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
  role?: UserRole;
}
