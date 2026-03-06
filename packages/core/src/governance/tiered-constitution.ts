/**
 * TieredConstitution — Wraps ConstitutionEnforcer with tier awareness.
 *
 * Adds governance tiers on top of the existing immutable constitution:
 *  - hard (critical severity):      throw immediately, no override
 *  - soft (high severity):          return violation, overridable with authority
 *  - aspirational (medium severity): log only, don't enforce
 *
 * Does NOT modify ConstitutionEnforcer — wraps it to add tier-aware behavior.
 */

import {
  type ConstitutionViolation,
  type ConstitutionTier,
  type ToolInvocation,
  ConstitutionViolationError,
} from '@joule/shared';
import type { ConstitutionEnforcer } from '../constitution.js';

// ── Result type ─────────────────────────────────────────────────────

export interface TieredValidationResult {
  violation: ConstitutionViolation | null;
  tier: ConstitutionTier;
  overridden: boolean;
  overrideAuthority?: string;
}

// ── Severity → Tier mapping ─────────────────────────────────────────

const SEVERITY_TO_TIER: Record<string, ConstitutionTier> = {
  critical: 'hard',
  high: 'soft',
  medium: 'aspirational',
};

// ── Main class ──────────────────────────────────────────────────────

export class TieredConstitution {
  private base: ConstitutionEnforcer;
  private overrideLog: Array<{ violation: ConstitutionViolation; authority: string; timestamp: string }> = [];

  constructor(base: ConstitutionEnforcer) {
    this.base = base;
  }

  /**
   * Validate a tool call with tier awareness.
   *
   * - hard tier:        always enforced (throws on critical, like base)
   * - soft tier:        enforced unless overrideAuthority is provided
   * - aspirational tier: logged but not enforced
   */
  validateToolCall(
    invocation: ToolInvocation,
    overrideAuthority?: string,
  ): TieredValidationResult {
    try {
      const violation = this.base.validateToolCall(invocation);

      if (!violation) {
        return { violation: null, tier: 'aspirational', overridden: false };
      }

      const tier = this.getTierForSeverity(violation.severity);

      // Aspirational: log but don't enforce
      if (tier === 'aspirational') {
        return { violation, tier, overridden: false };
      }

      // Soft: allow override with authority
      if (tier === 'soft' && overrideAuthority) {
        this.overrideLog.push({
          violation,
          authority: overrideAuthority,
          timestamp: new Date().toISOString(),
        });
        return { violation, tier, overridden: true, overrideAuthority };
      }

      // Hard or soft without override: enforce
      return { violation, tier, overridden: false };
    } catch (err) {
      // ConstitutionViolationError from critical rules
      if (err instanceof ConstitutionViolationError) {
        return {
          violation: {
            ruleId: err.ruleId,
            ruleName: err.ruleName,
            severity: 'critical',
            category: 'safety',
            description: err.message,
            timestamp: new Date().toISOString(),
          },
          tier: 'hard',
          overridden: false,
        };
      }
      throw err;
    }
  }

  /**
   * Validate LLM output with tier awareness.
   */
  validateOutput(output: string): TieredValidationResult {
    try {
      const violation = this.base.validateOutput(output);

      if (!violation) {
        return { violation: null, tier: 'aspirational', overridden: false };
      }

      const tier = this.getTierForSeverity(violation.severity);
      return { violation, tier, overridden: false };
    } catch (err) {
      if (err instanceof ConstitutionViolationError) {
        return {
          violation: {
            ruleId: err.ruleId,
            ruleName: err.ruleName,
            severity: 'critical',
            category: 'safety',
            description: err.message,
            timestamp: new Date().toISOString(),
          },
          tier: 'hard',
          overridden: false,
        };
      }
      throw err;
    }
  }

  /** Get the governance tier for a constitution rule by severity. */
  getTierForSeverity(severity: string): ConstitutionTier {
    return SEVERITY_TO_TIER[severity] ?? 'soft';
  }

  /** Get the override log (for auditing soft tier overrides). */
  getOverrideLog(): Array<{ violation: ConstitutionViolation; authority: string; timestamp: string }> {
    return [...this.overrideLog];
  }
}
