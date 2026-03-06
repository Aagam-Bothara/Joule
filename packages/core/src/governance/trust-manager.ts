/**
 * TrustManager — Per-agent trust profiles with tier-based autonomy.
 *
 * Manages trust scores (0.0–1.0) that determine agent capabilities:
 *  - probation (< 0.3):  limited tools, full oversight, 0.5× budget
 *  - standard  (0.3–0.6): normal tools, standard oversight, 1.0× budget
 *  - trusted   (0.6–0.8): extra tools, minimal oversight, 1.5× budget
 *  - senior    (> 0.8):  all tools, no oversight, 2.0× budget
 *
 * Persists via AgentMemory semantic facts (category: 'trust-profiles').
 */

import {
  type TrustProfile,
  type TrustTier,
  type TrustAdjustment,
  type ViolationRecord,
  type OversightLevel,
  type GovernanceConfig,
  type RewardType,
  type PunishmentType,
  isoNow,
  generateId,
} from '@joule/shared';
import type { AgentMemory } from '../agent-memory.js';

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  probation: 0.3,
  trusted: 0.6,
  senior: 0.8,
};

const TIER_BUDGET_MULTIPLIER: Record<TrustTier, number> = {
  probation: 0.5,
  standard: 1.0,
  trusted: 1.5,
  senior: 2.0,
};

const TIER_OVERSIGHT: Record<TrustTier, OversightLevel> = {
  probation: 'full',
  standard: 'standard',
  trusted: 'minimal',
  senior: 'none',
};

// ── Main class ──────────────────────────────────────────────────────

export class TrustManager {
  private profiles = new Map<string, TrustProfile>();
  private memory?: AgentMemory;
  private thresholds: { probation: number; trusted: number; senior: number };
  private defaultScore: number;
  private hydrated = false;

  constructor(memory?: AgentMemory, config?: GovernanceConfig) {
    this.memory = memory;
    this.defaultScore = config?.defaultTrustScore ?? 0.5;
    this.thresholds = {
      probation: config?.trustThresholds?.probation ?? DEFAULT_THRESHOLDS.probation,
      trusted: config?.trustThresholds?.trusted ?? DEFAULT_THRESHOLDS.trusted,
      senior: config?.trustThresholds?.senior ?? DEFAULT_THRESHOLDS.senior,
    };
  }

  /** Get or create a trust profile for an agent. */
  getProfile(agentId: string): TrustProfile {
    const existing = this.profiles.get(agentId);
    if (existing) return existing;

    const profile: TrustProfile = {
      agentId,
      trustScore: this.defaultScore,
      tier: this.computeTier(this.defaultScore),
      violationHistory: [],
      streaks: { clean: 0, violation: 0 },
      totalTasks: 0,
      successfulTasks: 0,
      toolsAllowed: [],
      toolsDenied: [],
      budgetMultiplier: TIER_BUDGET_MULTIPLIER[this.computeTier(this.defaultScore)],
      oversightLevel: TIER_OVERSIGHT[this.computeTier(this.defaultScore)],
      lastUpdated: isoNow(),
      createdAt: isoNow(),
    };

    this.profiles.set(agentId, profile);
    return profile;
  }

  /** Update an agent's trust score by delta. Clamps to [0, 1]. */
  updateScore(agentId: string, delta: number, reason: RewardType | PunishmentType): TrustAdjustment {
    const profile = this.getProfile(agentId);
    const oldScore = profile.trustScore;
    const oldTier = profile.tier;

    profile.trustScore = Math.max(0, Math.min(1, oldScore + delta));
    profile.tier = this.computeTier(profile.trustScore);
    profile.budgetMultiplier = TIER_BUDGET_MULTIPLIER[profile.tier];
    profile.oversightLevel = TIER_OVERSIGHT[profile.tier];
    profile.lastUpdated = isoNow();

    const adjustment: TrustAdjustment = {
      agentId,
      type: delta >= 0 ? 'reward' : 'punishment',
      reason,
      delta,
      oldScore,
      newScore: profile.trustScore,
      oldTier,
      newTier: profile.tier,
      timestamp: isoNow(),
    };

    return adjustment;
  }

  /** Compute the trust tier from a score. */
  computeTier(score: number): TrustTier {
    if (score < this.thresholds.probation) return 'probation';
    if (score < this.thresholds.trusted) return 'standard';
    if (score < this.thresholds.senior) return 'trusted';
    return 'senior';
  }

  /** Get the budget multiplier for an agent based on their trust tier. */
  getEffectiveBudgetMultiplier(agentId: string): number {
    return this.getProfile(agentId).budgetMultiplier;
  }

  /** Get the oversight level for an agent. */
  getEffectiveOversight(agentId: string): OversightLevel {
    return this.getProfile(agentId).oversightLevel;
  }

  /** Check if a tool is allowed for this agent based on trust. */
  isToolAllowed(agentId: string, toolName: string): boolean {
    const profile = this.getProfile(agentId);
    if (profile.toolsDenied.includes(toolName)) return false;
    return true;
  }

  /** Record a violation against an agent. */
  recordViolation(agentId: string, violation: ViolationRecord): void {
    const profile = this.getProfile(agentId);
    profile.violationHistory.push(violation);
    // Keep last 50 violations
    if (profile.violationHistory.length > 50) {
      profile.violationHistory = profile.violationHistory.slice(-50);
    }
    profile.streaks.violation++;
    profile.streaks.clean = 0;
    profile.lastUpdated = isoNow();
  }

  /** Record a successful task completion. */
  recordTaskSuccess(agentId: string): void {
    const profile = this.getProfile(agentId);
    profile.totalTasks++;
    profile.successfulTasks++;
    profile.streaks.clean++;
    profile.streaks.violation = 0;
    profile.lastUpdated = isoNow();
  }

  /** Record a task failure. */
  recordTaskFailure(agentId: string): void {
    const profile = this.getProfile(agentId);
    profile.totalTasks++;
    profile.lastUpdated = isoNow();
  }

  /** Get all trust profiles. */
  getProfiles(): TrustProfile[] {
    return [...this.profiles.values()];
  }

  /** Persist all profiles to memory. */
  async persist(): Promise<void> {
    if (!this.memory) return;

    for (const profile of this.profiles.values()) {
      await this.memory.storeFact(
        `trust-profile:${profile.agentId}`,
        profile,
        'trust-profiles',
        'trust-manager',
      );
    }
  }

  /** Hydrate profiles from memory. Only runs once. */
  async hydrate(): Promise<void> {
    if (this.hydrated || !this.memory) return;
    this.hydrated = true;

    const facts = await this.memory.searchFacts({ category: 'trust-profiles', limit: 100 });
    for (const fact of facts) {
      const profile = fact.value as TrustProfile;
      if (profile?.agentId && !this.profiles.has(profile.agentId)) {
        this.profiles.set(profile.agentId, profile);
      }
    }
  }
}
