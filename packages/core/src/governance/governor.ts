/**
 * Governor — Central governance coordinator.
 *
 * Programmatic (not LLM-based) rule evaluator that provides:
 *  - Pre-flight checks before agent execution
 *  - Runtime validation of tool calls
 *  - Post-task evaluation with reward/punishment
 *
 * Orchestrates all governance subsystems: TrustManager, PolicyEngine,
 * TieredConstitution, Vault, AccountabilityChain, RewardEngine,
 * ConsensusMechanism, SystemLearner.
 */

import {
  type GovernorDecision,
  type GovernanceStats,
  type TaskOutcomeForReward,
  type ViolationRecord,
  type ToolInvocation,
  type Task,
  type AgentResult,
  generateId,
  isoNow,
} from '@joule/shared';
import type { TrustManager } from './trust-manager.js';
import type { PolicyEngine } from './policy-engine.js';
import type { TieredConstitution } from './tiered-constitution.js';
import type { Vault } from './vault.js';
import type { AccountabilityChain } from './accountability.js';
import type { RewardEngine } from './reward-engine.js';
import type { ConsensusMechanism } from './consensus.js';
import type { SystemLearner } from './system-learner.js';

// ── Constructor options ─────────────────────────────────────────────

export interface GovernorOptions {
  trustManager: TrustManager;
  policyEngine: PolicyEngine;
  constitution: TieredConstitution;
  vault: Vault;
  accountability: AccountabilityChain;
  rewardEngine: RewardEngine;
  consensus: ConsensusMechanism;
  systemLearner: SystemLearner;
}

// ── Counters ────────────────────────────────────────────────────────

interface DecisionCounters {
  total: number;
  allowed: number;
  denied: number;
  restricted: number;
  escalated: number;
}

// ── Main class ──────────────────────────────────────────────────────

export class Governor {
  private trust: TrustManager;
  private policy: PolicyEngine;
  private constitution: TieredConstitution;
  private vault: Vault;
  private accountability: AccountabilityChain;
  private rewards: RewardEngine;
  private consensus: ConsensusMechanism;
  private learner: SystemLearner;
  private counters: DecisionCounters = { total: 0, allowed: 0, denied: 0, restricted: 0, escalated: 0 };

  constructor(options: GovernorOptions) {
    this.trust = options.trustManager;
    this.policy = options.policyEngine;
    this.constitution = options.constitution;
    this.vault = options.vault;
    this.accountability = options.accountability;
    this.rewards = options.rewardEngine;
    this.consensus = options.consensus;
    this.learner = options.systemLearner;
  }

  /**
   * Pre-flight check — called before an agent starts a task.
   * Validates trust, evaluates policies, checks consensus requirements.
   */
  preflight(agentId: string, task: Task): GovernorDecision {
    const profile = this.trust.getProfile(agentId);

    // 1. Deny terminated agents
    if (profile.trustScore === 0 && profile.totalTasks > 0) {
      return this.makeDecision('preflight', agentId, 'deny', 'Agent is terminated (trust = 0)', []);
    }

    // 2. Evaluate policies
    const context = {
      agentId,
      taskType: this.extractTaskType(task),
      trustTier: profile.tier,
      trustScore: profile.trustScore,
      action: 'task_start',
    };
    const actions = this.policy.evaluate(context);
    const ruleIds = this.policy.getMatchingRuleIds(context);

    // Check for blocking policies
    const blockAction = actions.find(a => a.type === 'block');
    if (blockAction) {
      return this.makeDecision('preflight', agentId, 'deny', 'Blocked by policy', ruleIds);
    }

    // Check for consensus requirement
    const consensusAction = actions.find(a => a.type === 'require_consensus');
    if (consensusAction) {
      return this.makeDecision('preflight', agentId, 'escalate', 'Consensus required', ruleIds);
    }

    // 3. Compute budget adjustments based on trust
    const budgetMultiplier = this.trust.getEffectiveBudgetMultiplier(agentId);
    const oversight = this.trust.getEffectiveOversight(agentId);

    // 4. Check for budget reduction policies
    const reduceAction = actions.find(a => a.type === 'reduce_budget');
    const effectiveMultiplier = reduceAction?.params?.multiplier
      ? Math.min(budgetMultiplier, reduceAction.params.multiplier as number)
      : budgetMultiplier;

    // 5. Issue vault tokens if needed
    // (Token issuance is delegated to the caller based on task requirements)

    const decision = this.makeDecision('preflight', agentId, 'allow', 'Pre-flight passed', ruleIds, {
      budgetMultiplier: effectiveMultiplier,
      oversightLevel: oversight,
    });

    return decision;
  }

  /**
   * Runtime validation — called before each tool invocation.
   * Checks trust-based access, policy rules, and tiered constitution.
   */
  validateToolCall(agentId: string, invocation: ToolInvocation): GovernorDecision {
    const profile = this.trust.getProfile(agentId);

    // 1. Check trust-based tool access
    if (!this.trust.isToolAllowed(agentId, invocation.toolName)) {
      return this.makeDecision('runtime', agentId, 'deny',
        `Tool '${invocation.toolName}' denied by trust profile`, []);
    }

    // 2. Evaluate policies
    const context = {
      agentId,
      toolName: invocation.toolName,
      trustTier: profile.tier,
      trustScore: profile.trustScore,
      action: 'tool_call',
    };
    const actions = this.policy.evaluate(context);
    const ruleIds = this.policy.getMatchingRuleIds(context);

    const blockAction = actions.find(a => a.type === 'block');
    if (blockAction) {
      return this.makeDecision('runtime', agentId, 'deny',
        `Tool '${invocation.toolName}' blocked by policy`, ruleIds);
    }

    // 3. Tiered constitution check
    const constitutionResult = this.constitution.validateToolCall(
      invocation,
      profile.tier === 'senior' ? 'senior-agent' : undefined,
    );

    if (constitutionResult.violation && !constitutionResult.overridden) {
      if (constitutionResult.tier === 'hard') {
        // Record violation
        this.trust.recordViolation(agentId, {
          id: generateId('vio'),
          agentId,
          ruleId: constitutionResult.violation.ruleId,
          severity: 'strike',
          description: constitutionResult.violation.description,
          timestamp: isoNow(),
        });
        return this.makeDecision('runtime', agentId, 'deny',
          `Hard constitution violation: ${constitutionResult.violation.description}`, ruleIds);
      }

      if (constitutionResult.tier === 'soft') {
        // Soft violation — restrict but don't block
        return this.makeDecision('runtime', agentId, 'restrict',
          `Soft constitution violation: ${constitutionResult.violation.description}`, ruleIds);
      }
      // Aspirational: log only, allow
    }

    // 4. Check consensus requirement
    if (this.consensus.isActionRequiringConsensus(invocation.toolName)) {
      return this.makeDecision('runtime', agentId, 'escalate',
        `Consensus required for '${invocation.toolName}'`, ruleIds);
    }

    return this.makeDecision('runtime', agentId, 'allow', 'Tool call approved', ruleIds);
  }

  /**
   * Post-task evaluation — called after an agent completes a task.
   * Evaluates outcome, applies rewards/punishments, updates trust.
   */
  postTask(agentId: string, result: AgentResult): GovernorDecision {
    const profile = this.trust.getProfile(agentId);

    // 1. Evaluate outcome
    const success = result.taskResult.status === 'completed';
    const budgetUsed = result.taskResult.budgetUsed;
    const underBudget = budgetUsed
      ? budgetUsed.costRemaining > 0 && budgetUsed.tokensRemaining > 0
      : false;

    // 2. Collect violations from this task (check recent history)
    const recentViolations = profile.violationHistory.filter(v => {
      const vTime = new Date(v.timestamp).getTime();
      const now = Date.now();
      return now - vTime < 60_000; // violations in last 60s
    });

    // 3. Apply reward/punishment
    const outcome: TaskOutcomeForReward = {
      success,
      underBudget,
      violations: recentViolations,
      selfReported: false,
      toolsUsed: [],
      durationMs: budgetUsed?.elapsedMs ?? 0,
      costUsd: budgetUsed?.costUsd ?? 0,
    };

    this.rewards.evaluateTaskOutcome(agentId, outcome);

    // 4. Revoke vault tokens for this agent
    this.vault.revokeAllForAgent(agentId, 'task_complete');

    // 5. Feed to system learner
    this.learner.recordTask();

    // 6. Record accountability
    const ruleIds = this.policy.getMatchingRuleIds({
      agentId,
      trustTier: profile.tier,
      trustScore: profile.trustScore,
      action: 'post_task',
    });

    const decision = this.makeDecision(
      'post_task', agentId,
      success ? 'allow' : 'restrict',
      success ? 'Task completed successfully' : `Task ${result.taskResult.status}`,
      ruleIds,
    );

    return decision;
  }

  /**
   * Get governance statistics.
   */
  getStats(): GovernanceStats {
    const profiles = this.trust.getProfiles();
    const avgTrust = profiles.length > 0
      ? profiles.reduce((sum, p) => sum + p.trustScore, 0) / profiles.length
      : 0;

    return {
      totalDecisions: this.counters.total,
      allowed: this.counters.allowed,
      denied: this.counters.denied,
      restricted: this.counters.restricted,
      escalated: this.counters.escalated,
      agentCount: profiles.length,
      averageTrustScore: avgTrust,
      activeVaultTokens: this.vault.size(),
      insightsGenerated: this.learner.getInsights().length,
      policyAdjustments: this.learner.getAdjustments().length,
    };
  }

  /** Access subsystems for direct use. */
  getTrustManager(): TrustManager { return this.trust; }
  getPolicyEngine(): PolicyEngine { return this.policy; }
  getVault(): Vault { return this.vault; }
  getAccountability(): AccountabilityChain { return this.accountability; }
  getConsensus(): ConsensusMechanism { return this.consensus; }
  getSystemLearner(): SystemLearner { return this.learner; }

  // ── Private ──────────────────────────────────────────────────────

  private makeDecision(
    type: GovernorDecision['type'],
    agentId: string,
    decision: GovernorDecision['decision'],
    reason: string,
    policyRules: string[],
    adjustments?: GovernorDecision['adjustments'],
  ): GovernorDecision {
    const profile = this.trust.getProfile(agentId);

    // Update counters
    const counterMap: Record<string, keyof DecisionCounters> = {
      allow: 'allowed', deny: 'denied', restrict: 'restricted', escalate: 'escalated',
    };
    this.counters.total++;
    this.counters[counterMap[decision]]++;

    // Record in accountability chain
    this.accountability.record({
      agentId,
      action: `${type}:${reason.slice(0, 50)}`,
      governorDecision: decision,
      policyRuleId: policyRules[0],
      trustScoreAtTime: profile.trustScore,
      metadata: adjustments ? { adjustments } : undefined,
    });

    return {
      type,
      agentId,
      decision,
      reason,
      policyRules,
      trustScore: profile.trustScore,
      adjustments,
      timestamp: isoNow(),
    };
  }

  private extractTaskType(task: Task): string {
    // Simple heuristic: extract from task description or context
    const desc = task.description.toLowerCase();
    if (desc.includes('review') || desc.includes('audit')) return 'code-review';
    if (desc.includes('fix') || desc.includes('bug')) return 'bug-fix';
    if (desc.includes('deploy') || desc.includes('release')) return 'deploy';
    if (desc.includes('research') || desc.includes('search')) return 'research';
    if (desc.includes('test')) return 'testing';
    return 'general';
  }
}
