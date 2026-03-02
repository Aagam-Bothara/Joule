/**
 * EnhancedRateLimiter — Tiered, per-endpoint, cost-based rate limiting.
 *
 * Supports SQLite persistence, adaptive load-based throttling,
 * and per-user role tiers. Falls back to in-memory when no DB provided.
 */

export interface RateLimitTier {
  name: string;
  requestsPerMinute: number;
  requestsPerHour?: number;
  costPerMinuteUsd?: number;
}

export interface RateLimitConfig {
  tiers: Record<string, RateLimitTier>;
  defaultTier: string;
  perEndpoint?: Record<string, { requestsPerMinute: number }>;
  adaptiveEnabled?: boolean;
  adaptiveThreshold?: number; // memory usage % to trigger reduction
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
}

interface BucketEntry {
  count: number;
  costUsd: number;
  resetAt: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  tiers: {
    default: { name: 'default', requestsPerMinute: 60 },
    admin: { name: 'admin', requestsPerMinute: 300 },
    premium: { name: 'premium', requestsPerMinute: 120 },
  },
  defaultTier: 'default',
};

export class EnhancedRateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private config: RateLimitConfig;
  private db?: any;

  constructor(config?: Partial<RateLimitConfig>, db?: any) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = db;
    if (this.db) {
      this.ensureTable();
      this.loadFromDb();
    }
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          bucket_key TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          reset_at TEXT NOT NULL
        )
      `);
    } catch {
      // Table creation failed — continue with in-memory only
    }
  }

  private loadFromDb(): void {
    try {
      const rows = this.db.prepare('SELECT * FROM rate_limits WHERE reset_at > ?')
        .all(new Date().toISOString()) as Array<{
          bucket_key: string; count: number; cost_usd: number; reset_at: string;
        }>;

      for (const row of rows) {
        this.buckets.set(row.bucket_key, {
          count: row.count,
          costUsd: row.cost_usd,
          resetAt: new Date(row.reset_at).getTime(),
        });
      }
    } catch {
      // Load failed — start fresh
    }
  }

  /**
   * Check if a request is allowed under rate limits.
   */
  check(userId: string, userRole: string, endpoint: string, estimatedCostUsd?: number): RateLimitResult {
    const now = Date.now();
    const tierName = this.config.tiers[userRole] ? userRole : this.config.defaultTier;
    const tier = this.config.tiers[tierName] ?? this.config.tiers[this.config.defaultTier];

    if (!tier) {
      return { allowed: true, remaining: 999, resetAt: now + 60_000 };
    }

    let limit = tier.requestsPerMinute;

    // Per-endpoint override
    if (this.config.perEndpoint?.[endpoint]) {
      limit = Math.min(limit, this.config.perEndpoint[endpoint].requestsPerMinute);
    }

    // Adaptive throttling
    if (this.config.adaptiveEnabled) {
      limit = Math.floor(limit * this.getAdaptiveMultiplier());
    }

    const bucketKey = `${userId}:${endpoint}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, costUsd: 0, resetAt: now + 60_000 };
      this.buckets.set(bucketKey, bucket);
    }

    const remaining = Math.max(0, limit - bucket.count);

    // Cost-based limit check
    if (tier.costPerMinuteUsd !== undefined && estimatedCostUsd !== undefined) {
      if (bucket.costUsd + estimatedCostUsd > tier.costPerMinuteUsd) {
        return {
          allowed: false,
          remaining: 0,
          resetAt: bucket.resetAt,
          retryAfterMs: bucket.resetAt - now,
        };
      }
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterMs: bucket.resetAt - now,
      };
    }

    return { allowed: true, remaining: remaining - 1, resetAt: bucket.resetAt };
  }

  /**
   * Record a request against the rate limit.
   */
  record(userId: string, endpoint: string, costUsd = 0): void {
    const now = Date.now();
    const bucketKey = `${userId}:${endpoint}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, costUsd: 0, resetAt: now + 60_000 };
      this.buckets.set(bucketKey, bucket);
    }

    bucket.count++;
    bucket.costUsd += costUsd;
  }

  /**
   * Get adaptive rate multiplier based on system memory usage.
   * Returns 1.0 under normal load, scales down to 0.5 under high load.
   */
  getAdaptiveMultiplier(): number {
    try {
      const memUsage = process.memoryUsage();
      const heapUsedPercent = memUsage.heapUsed / memUsage.heapTotal;
      const threshold = this.config.adaptiveThreshold ?? 0.8;

      if (heapUsedPercent > threshold) {
        // Scale linearly from 1.0 at threshold to 0.5 at 100%
        const excess = (heapUsedPercent - threshold) / (1 - threshold);
        return Math.max(0.5, 1.0 - excess * 0.5);
      }
    } catch {
      // Ignore errors in memory check
    }
    return 1.0;
  }

  /** Persist in-memory state to SQLite (if DB available). */
  flush(): void {
    if (!this.db) return;

    try {
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO rate_limits (bucket_key, count, cost_usd, reset_at)
        VALUES (?, ?, ?, ?)
      `);

      const txn = this.db.transaction(() => {
        for (const [key, bucket] of this.buckets) {
          insert.run(key, bucket.count, bucket.costUsd, new Date(bucket.resetAt).toISOString());
        }
      });

      txn();
    } catch {
      // Persistence failed — continue with in-memory
    }
  }

  /** Get the tier for a given role. */
  getTier(role: string): RateLimitTier | undefined {
    return this.config.tiers[role] ?? this.config.tiers[this.config.defaultTier];
  }
}
