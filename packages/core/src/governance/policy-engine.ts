/**
 * PolicyEngine — YAML-defined rules compiled into runtime constraints.
 *
 * Evaluates policy rules against a runtime context (agentId, taskType,
 * toolName, trustTier, trustScore) and returns matching actions.
 *
 * Rules have:
 *  - conditions: field + operator + value (simple pattern matching, no eval)
 *  - actions: block, allow, require_approval, log, reduce_budget, require_consensus
 *  - tier: hard > soft > aspirational (conflict resolution)
 *  - priority: higher wins within same tier
 */

import type {
  PolicyRule,
  PolicyCondition,
  PolicyAction,
  PolicyContext,
  ConstitutionTier,
} from '@joule/shared';

// ── Tier ordering (for conflict resolution) ─────────────────────────

const TIER_ORDER: Record<ConstitutionTier, number> = {
  hard: 3,
  soft: 2,
  aspirational: 1,
};

// ── Action restrictiveness (higher = more restrictive) ──────────────

const ACTION_RESTRICTIVENESS: Record<string, number> = {
  block: 5,
  require_consensus: 4,
  require_approval: 3,
  reduce_budget: 2,
  log: 1,
  allow: 0,
};

// ── Main class ──────────────────────────────────────────────────────

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  /** Rules sorted by tier (desc) then priority (desc) for fast evaluation. */
  private compiled: PolicyRule[] = [];

  constructor(rules?: PolicyRule[]) {
    if (rules) {
      this.rules = [...rules];
      this.compile();
    }
  }

  /**
   * Evaluate all rules against the given context.
   * Returns matching actions sorted by tier (hard first) then priority (high first).
   * Conflicting actions at the same tier: more restrictive wins.
   */
  evaluate(context: PolicyContext): PolicyAction[] {
    const matchingActions: Array<{ action: PolicyAction; tier: ConstitutionTier; priority: number; ruleId: string }> = [];

    for (const rule of this.compiled) {
      if (this.matchesAllConditions(rule.conditions, context)) {
        for (const action of rule.actions) {
          matchingActions.push({
            action,
            tier: rule.tier,
            priority: rule.priority,
            ruleId: rule.id,
          });
        }
      }
    }

    // Deduplicate by action type — keep highest tier/priority/restrictiveness
    const byType = new Map<string, typeof matchingActions[0]>();
    for (const entry of matchingActions) {
      const existing = byType.get(entry.action.type);
      if (!existing || this.isHigherPrecedence(entry, existing)) {
        byType.set(entry.action.type, entry);
      }
    }

    // Return actions sorted: most restrictive first
    return [...byType.values()]
      .sort((a, b) => {
        const restrictA = ACTION_RESTRICTIVENESS[a.action.type] ?? 0;
        const restrictB = ACTION_RESTRICTIVENESS[b.action.type] ?? 0;
        return restrictB - restrictA;
      })
      .map(e => e.action);
  }

  /**
   * Get matching rule IDs for a context (for accountability).
   */
  getMatchingRuleIds(context: PolicyContext): string[] {
    return this.compiled
      .filter(rule => this.matchesAllConditions(rule.conditions, context))
      .map(rule => rule.id);
  }

  /** Add a rule and recompile. */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.compile();
  }

  /** Remove a rule by ID and recompile. */
  removeRule(ruleId: string): boolean {
    const idx = this.rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.compile();
    return true;
  }

  /** Get all rules. */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /** Rebuild the compiled index (sort by tier desc, priority desc). */
  compile(): void {
    this.compiled = [...this.rules].sort((a, b) => {
      const tierDiff = TIER_ORDER[b.tier] - TIER_ORDER[a.tier];
      if (tierDiff !== 0) return tierDiff;
      return b.priority - a.priority;
    });
  }

  // ── Private ──────────────────────────────────────────────────────

  /** Check if all conditions match against the context. */
  private matchesAllConditions(conditions: PolicyCondition[], context: PolicyContext): boolean {
    return conditions.every(cond => this.matchCondition(cond, context));
  }

  /** Evaluate a single condition against the context. */
  private matchCondition(condition: PolicyCondition, context: PolicyContext): boolean {
    const fieldValue = this.getFieldValue(context, condition.field);
    if (fieldValue === undefined) return false;

    const { operator, value } = condition;

    switch (operator) {
      case 'eq':
        return fieldValue === value;
      case 'neq':
        return fieldValue !== value;
      case 'gt':
        return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue > value;
      case 'lt':
        return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue < value;
      case 'gte':
        return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue >= value;
      case 'lte':
        return typeof fieldValue === 'number' && typeof value === 'number' && fieldValue <= value;
      case 'in':
        return Array.isArray(value) && value.some(v => v === fieldValue || String(v) === String(fieldValue));
      case 'matches':
        try {
          return typeof value === 'string' && new RegExp(value).test(String(fieldValue));
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /** Extract a field value from the context. */
  private getFieldValue(context: PolicyContext, field: string): string | number | undefined {
    switch (field) {
      case 'agentId': return context.agentId;
      case 'taskType': return context.taskType;
      case 'toolName': return context.toolName;
      case 'trustTier': return context.trustTier;
      case 'trustScore': return context.trustScore;
      case 'action': return context.action;
      default: return undefined;
    }
  }

  /** Check if entry A has higher precedence than entry B. */
  private isHigherPrecedence(
    a: { tier: ConstitutionTier; priority: number; action: PolicyAction },
    b: { tier: ConstitutionTier; priority: number; action: PolicyAction },
  ): boolean {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff > 0;
    if (a.priority !== b.priority) return a.priority > b.priority;
    // Same tier + priority: more restrictive wins
    const restrictA = ACTION_RESTRICTIVENESS[a.action.type] ?? 0;
    const restrictB = ACTION_RESTRICTIVENESS[b.action.type] ?? 0;
    return restrictA > restrictB;
  }
}
