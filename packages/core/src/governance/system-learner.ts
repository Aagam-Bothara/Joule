/**
 * SystemLearner — Spots patterns across all agents and adapts policies.
 *
 * Analyzes aggregated trust profile data, violation patterns, and tool
 * effectiveness to detect systemic issues and suggest policy adjustments.
 *
 * Examples:
 *  - "All agents fail on deploy tasks" → suggest higher budget
 *  - "shell_exec has 80% failure rate" → suggest requiring approval
 *  - "SAFETY-001 triggered 12 times this session" → violation hotspot
 */

import {
  type SystemInsight,
  type PolicyAdjustment,
  type PolicyRule,
  generateId,
  isoNow,
} from '@joule/shared';
import type { TrustManager } from './trust-manager.js';
import type { PolicyEngine } from './policy-engine.js';
import type { AgentMemory } from '../agent-memory.js';

// ── Thresholds ──────────────────────────────────────────────────────

const DEFAULT_MIN_DATA_POINTS = 5;

// ── Main class ──────────────────────────────────────────────────────

export class SystemLearner {
  private trustManager: TrustManager;
  private insights: SystemInsight[] = [];
  private adjustments: PolicyAdjustment[] = [];
  private minDataPoints: number;
  private taskCount = 0;
  private analysisInterval: number;
  private enabled: boolean;

  constructor(
    trustManager: TrustManager,
    _memory?: AgentMemory,
    config?: { enabled?: boolean; minDataPoints?: number; analysisIntervalTasks?: number },
  ) {
    this.trustManager = trustManager;
    this.enabled = config?.enabled !== false; // default true
    this.minDataPoints = config?.minDataPoints ?? DEFAULT_MIN_DATA_POINTS;
    this.analysisInterval = config?.analysisIntervalTasks ?? 10;
  }

  /** Record a task completion. Triggers analysis at intervals. */
  recordTask(): boolean {
    if (!this.enabled) return false;
    this.taskCount++;
    if (this.taskCount % this.analysisInterval === 0) {
      this.analyze();
      return true;  // analysis was triggered
    }
    return false;
  }

  /**
   * Analyze all agent data and generate insights.
   * Detects 4 pattern categories: task failures, tool issues, budget overuse, violation hotspots.
   */
  analyze(): SystemInsight[] {
    const newInsights: SystemInsight[] = [];
    const profiles = this.trustManager.getProfiles();

    if (profiles.length < 1) return newInsights;

    // 1. Detect agents with consistently low trust scores
    const lowTrustAgents = profiles.filter(
      p => p.totalTasks >= this.minDataPoints && p.trustScore < 0.3,
    );
    if (lowTrustAgents.length > 0) {
      newInsights.push({
        id: generateId('ins'),
        pattern: `${lowTrustAgents.length} agent(s) in probation tier after ${this.minDataPoints}+ tasks`,
        category: 'task_failure',
        affectedAgents: lowTrustAgents.map(p => p.agentId),
        affectedTaskTypes: [],
        confidence: Math.min(lowTrustAgents.length / profiles.length, 1),
        dataPoints: lowTrustAgents.reduce((sum, p) => sum + p.totalTasks, 0),
        suggestedAction: 'Review agent configurations or increase training data',
        timestamp: isoNow(),
      });
    }

    // 2. Detect high failure rates across all agents
    const totalTasks = profiles.reduce((sum, p) => sum + p.totalTasks, 0);
    const totalSuccesses = profiles.reduce((sum, p) => sum + p.successfulTasks, 0);
    if (totalTasks >= this.minDataPoints) {
      const overallSuccessRate = totalSuccesses / totalTasks;
      if (overallSuccessRate < 0.5) {
        newInsights.push({
          id: generateId('ins'),
          pattern: `System-wide success rate is ${(overallSuccessRate * 100).toFixed(0)}% (below 50%)`,
          category: 'task_failure',
          affectedAgents: profiles.map(p => p.agentId),
          affectedTaskTypes: [],
          confidence: totalTasks >= this.minDataPoints * 2 ? 0.9 : 0.6,
          dataPoints: totalTasks,
          suggestedAction: 'Consider increasing budgets or reviewing task complexity',
          timestamp: isoNow(),
        });
      }
    }

    // 3. Detect violation hotspots
    const violationCounts = new Map<string, { count: number; agents: Set<string> }>();
    for (const profile of profiles) {
      for (const v of profile.violationHistory) {
        const entry = violationCounts.get(v.ruleId) ?? { count: 0, agents: new Set() };
        entry.count++;
        entry.agents.add(v.agentId);
        violationCounts.set(v.ruleId, entry);
      }
    }

    for (const [ruleId, { count, agents }] of violationCounts) {
      if (count >= this.minDataPoints) {
        newInsights.push({
          id: generateId('ins'),
          pattern: `Rule ${ruleId} violated ${count} times by ${agents.size} agent(s)`,
          category: 'violation_hotspot',
          affectedAgents: [...agents],
          affectedTaskTypes: [],
          confidence: Math.min(count / (this.minDataPoints * 2), 1),
          dataPoints: count,
          suggestedAction: `Review rule ${ruleId} — may need clearer guidance or stricter enforcement`,
          timestamp: isoNow(),
        });
      }
    }

    // 4. Detect agents that always fail (budget overuse pattern)
    for (const profile of profiles) {
      if (profile.totalTasks >= this.minDataPoints && profile.successfulTasks === 0) {
        newInsights.push({
          id: generateId('ins'),
          pattern: `Agent ${profile.agentId} has 0% success rate after ${profile.totalTasks} tasks`,
          category: 'budget_overuse',
          affectedAgents: [profile.agentId],
          affectedTaskTypes: [],
          confidence: 0.9,
          dataPoints: profile.totalTasks,
          suggestedAction: `Investigate agent ${profile.agentId} — may need different tools or configuration`,
          timestamp: isoNow(),
        });
      }
    }

    this.insights.push(...newInsights);
    return newInsights;
  }

  /**
   * Generate policy adjustment suggestions based on current insights.
   */
  suggestPolicyAdjustments(): PolicyAdjustment[] {
    const suggestions: PolicyAdjustment[] = [];

    for (const insight of this.insights) {
      if (insight.category === 'violation_hotspot' && insight.dataPoints >= this.minDataPoints * 2) {
        suggestions.push({
          id: generateId('adj'),
          insightId: insight.id,
          description: `Add stricter policy for frequently violated rule: ${insight.pattern}`,
          applied: false,
          newRule: {
            id: `auto-${insight.id}`,
            name: `Auto-generated: ${insight.pattern.slice(0, 50)}`,
            tier: 'soft',
            conditions: insight.affectedAgents.length < 3
              ? [{ field: 'agentId', operator: 'in' as const, value: insight.affectedAgents }]
              : [], // applies to all if widespread
            actions: [{ type: 'require_approval' as const }],
            priority: 1,
          },
        });
      }

      if (insight.category === 'budget_overuse') {
        suggestions.push({
          id: generateId('adj'),
          insightId: insight.id,
          description: `Reduce budget for consistently failing agent: ${insight.affectedAgents[0]}`,
          applied: false,
          newRule: {
            id: `auto-budget-${insight.id}`,
            name: `Auto-generated: reduce budget for ${insight.affectedAgents[0]}`,
            tier: 'soft',
            conditions: [{ field: 'agentId', operator: 'eq' as const, value: insight.affectedAgents[0] }],
            actions: [{ type: 'reduce_budget' as const, params: { multiplier: 0.5 } }],
            priority: 2,
          },
        });
      }
    }

    return suggestions;
  }

  /**
   * Apply a policy adjustment to the engine.
   */
  applyAdjustment(adjustment: PolicyAdjustment, policyEngine: PolicyEngine): boolean {
    if (adjustment.applied) return false;

    if (adjustment.newRule) {
      policyEngine.addRule(adjustment.newRule);
      adjustment.applied = true;
      adjustment.appliedAt = isoNow();
      this.adjustments.push(adjustment);
      return true;
    }

    return false;
  }

  /** Get all generated insights. */
  getInsights(): SystemInsight[] {
    return [...this.insights];
  }

  /** Get all applied adjustments. */
  getAdjustments(): PolicyAdjustment[] {
    return [...this.adjustments];
  }

  /** Get task count since creation. */
  getTaskCount(): number {
    return this.taskCount;
  }
}
