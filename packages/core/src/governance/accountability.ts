/**
 * AccountabilityChain — Immutable append-only provenance trail.
 *
 * Records every governance decision with full lineage:
 *   agent → governor decision → policy rule → constitution rule → tier
 *
 * Enables queries like "why was this tool blocked?" by following the chain
 * from a decision back to the constitutional principle that triggered it.
 */

import {
  type AccountabilityEntry,
  type TraceEvent,
  generateId,
  isoNow,
  monotonicNow,
} from '@joule/shared';

// ── Query filters ───────────────────────────────────────────────────

export interface AccountabilityQuery {
  agentId?: string;
  action?: string;
  decision?: 'allow' | 'deny' | 'restrict' | 'escalate';
  since?: string;           // ISO timestamp
  limit?: number;
}

// ── Main class ──────────────────────────────────────────────────────

export class AccountabilityChain {
  /** Append-only log. Never delete, never mutate existing entries. */
  private entries: AccountabilityEntry[] = [];

  /**
   * Record a governance decision. Returns the created entry.
   */
  record(entry: Omit<AccountabilityEntry, 'id' | 'timestamp'>): AccountabilityEntry {
    const full: AccountabilityEntry = {
      ...entry,
      id: generateId('acc'),
      timestamp: isoNow(),
    };

    this.entries.push(full);
    return full;
  }

  /**
   * Query entries by filters. Returns newest first.
   */
  query(filters: AccountabilityQuery): AccountabilityEntry[] {
    let results = this.entries;

    if (filters.agentId) {
      results = results.filter(e => e.agentId === filters.agentId);
    }
    if (filters.action) {
      results = results.filter(e => e.action === filters.action);
    }
    if (filters.decision) {
      results = results.filter(e => e.governorDecision === filters.decision);
    }
    if (filters.since) {
      results = results.filter(e => e.timestamp >= filters.since!);
    }

    // Newest first
    const sorted = [...results].reverse();

    if (filters.limit) {
      return sorted.slice(0, filters.limit);
    }
    return sorted;
  }

  /**
   * Get a single entry by ID.
   */
  getEntry(entryId: string): AccountabilityEntry | undefined {
    return this.entries.find(e => e.id === entryId);
  }

  /**
   * Get all entries (oldest first).
   */
  getEntries(): AccountabilityEntry[] {
    return [...this.entries];
  }

  /**
   * Get all denial entries for a specific agent (newest first).
   */
  getDenials(agentId: string): AccountabilityEntry[] {
    return this.query({ agentId, decision: 'deny' });
  }

  /**
   * Convert entries to TraceEvent format for integration with TraceLogger.
   */
  toTraceEvents(traceId: string): TraceEvent[] {
    return this.entries.map(entry => {
      const eventType = entry.action.startsWith('preflight:')
        ? 'governance_preflight' as const
        : entry.action.startsWith('post_task:')
          ? 'governance_post_task' as const
          : 'governance_runtime' as const;

      return {
        id: entry.id,
        traceId,
        type: eventType,
        timestamp: monotonicNow(),
        wallClock: entry.timestamp,
        data: {
          agentId: entry.agentId,
          action: entry.action,
          decision: entry.governorDecision,
          policyRuleId: entry.policyRuleId,
          constitutionRuleId: entry.constitutionRuleId,
          tier: entry.constitutionTier,
          trustScore: entry.trustScoreAtTime,
          ...entry.metadata,
        },
      };
    });
  }

  /** Total number of entries. */
  size(): number {
    return this.entries.length;
  }
}
