/**
 * Governance Types — v0.8 Governed Orchestration
 *
 * Defines all types for the governance layer:
 *  - Tiered constitution (hard/soft/aspirational)
 *  - Policy engine (condition-based rules)
 *  - Agent trust profiles and reward/punishment
 *  - Vault (JIT credential access)
 *  - Accountability chain (provenance trail)
 *  - Consensus mechanism (multi-agent agreement)
 *  - System-level learning
 */

// ── Constitution Tiers ──────────────────────────────────────────────

/** Hard = never violated; Soft = overridable with authority; Aspirational = guidance only */
export type ConstitutionTier = 'hard' | 'soft' | 'aspirational';

// ── Trust ───────────────────────────────────────────────────────────

export type TrustTier = 'probation' | 'standard' | 'trusted' | 'senior';

export type OversightLevel = 'full' | 'standard' | 'minimal' | 'none';

export interface TrustProfile {
  agentId: string;
  trustScore: number;           // 0.0–1.0
  tier: TrustTier;
  violationHistory: ViolationRecord[];
  streaks: { clean: number; violation: number };
  totalTasks: number;
  successfulTasks: number;
  toolsAllowed: string[];       // extra tools granted by tier
  toolsDenied: string[];        // tools revoked due to violations
  budgetMultiplier: number;     // 0.5–2.0, scales agent budget
  oversightLevel: OversightLevel;
  lastUpdated: string;
  createdAt: string;
}

export type ViolationSeverity = 'warning' | 'strike' | 'suspension' | 'termination';

export interface ViolationRecord {
  id: string;
  agentId: string;
  ruleId: string;
  severity: ViolationSeverity;
  description: string;
  timestamp: string;
}

export type RewardType = 'task_success' | 'under_budget' | 'clean_streak' | 'self_report';
export type PunishmentType = 'violation' | 'budget_overuse' | 'repeated_failure' | 'dangerous_tool';

export interface TrustAdjustment {
  agentId: string;
  type: 'reward' | 'punishment';
  reason: RewardType | PunishmentType;
  delta: number;
  oldScore: number;
  newScore: number;
  oldTier: TrustTier;
  newTier: TrustTier;
  timestamp: string;
}

// ── Policy Engine ───────────────────────────────────────────────────

export type PolicyOperator = 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'matches';

export interface PolicyCondition {
  field: string;                // 'taskType', 'agentId', 'toolName', 'trustTier', 'trustScore'
  operator: PolicyOperator;
  value: string | number | string[];
}

export type PolicyActionType =
  | 'block'
  | 'allow'
  | 'require_approval'
  | 'log'
  | 'reduce_budget'
  | 'require_consensus';

export interface PolicyAction {
  type: PolicyActionType;
  params?: Record<string, unknown>;
}

export interface PolicyRule {
  id: string;
  name: string;
  description?: string;
  constitutionRef?: string;     // references a ConstitutionRule.id
  tier: ConstitutionTier;
  conditions: PolicyCondition[];
  actions: PolicyAction[];
  priority: number;             // higher wins in conflicts
}

/** Runtime context passed to PolicyEngine.evaluate() */
export interface PolicyContext {
  agentId: string;
  taskType?: string;
  toolName?: string;
  trustTier: TrustTier;
  trustScore: number;
  action?: string;              // e.g., 'tool_call', 'plan_revision'
}

// ── Vault ───────────────────────────────────────────────────────────

export interface VaultToken {
  id: string;
  agentId: string;
  resource: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  revoked: boolean;
  revokedAt?: string;
  revokedReason?: string;
}

// ── Accountability ──────────────────────────────────────────────────

export interface AccountabilityEntry {
  id: string;
  timestamp: string;
  agentId: string;
  action: string;
  governorDecision: 'allow' | 'deny' | 'restrict' | 'escalate';
  policyRuleId?: string;
  constitutionRuleId?: string;
  constitutionTier?: ConstitutionTier;
  trustScoreAtTime: number;
  metadata?: Record<string, unknown>;
}

// ── Consensus ───────────────────────────────────────────────────────

export interface ConsensusVote {
  agentId: string;
  vote: 'approve' | 'reject' | 'abstain';
  reason?: string;
  timestamp: string;
}

export interface ConsensusRequest {
  id: string;
  action: string;
  initiatorAgentId: string;
  requiredVoters: string[];
  votingMode: 'majority' | 'unanimous';
  votes: ConsensusVote[];
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  deadline: string;
}

// ── Governor ────────────────────────────────────────────────────────

export type GovernorDecisionType = 'preflight' | 'runtime' | 'post_task';

export interface GovernorDecision {
  type: GovernorDecisionType;
  agentId: string;
  decision: 'allow' | 'deny' | 'restrict' | 'escalate';
  reason: string;
  policyRules: string[];        // IDs of matching policy rules
  trustScore: number;
  adjustments?: {
    budgetMultiplier?: number;
    toolsRestricted?: string[];
    oversightLevel?: OversightLevel;
  };
  timestamp: string;
}

// ── System Learning ─────────────────────────────────────────────────

export interface SystemInsight {
  id: string;
  pattern: string;              // human-readable description
  category: 'task_failure' | 'tool_issue' | 'budget_overuse' | 'violation_hotspot';
  affectedAgents: string[];
  affectedTaskTypes: string[];
  confidence: number;           // 0-1
  dataPoints: number;
  suggestedAction?: string;
  timestamp: string;
}

export interface PolicyAdjustment {
  id: string;
  insightId: string;
  ruleId?: string;              // existing rule to modify
  newRule?: PolicyRule;          // or a new rule to add
  description: string;
  applied: boolean;
  appliedAt?: string;
}

// ── Governance Config ───────────────────────────────────────────────

export interface GovernanceConfig {
  enabled: boolean;
  defaultTrustScore?: number;   // default: 0.5
  trustThresholds?: {
    probation: number;          // default: 0.3
    trusted: number;            // default: 0.6
    senior: number;             // default: 0.8
  };
  policies?: PolicyRule[];
  consensus?: {
    enabled: boolean;
    requiredFor?: string[];     // tool names or action types
    votingMode?: 'majority' | 'unanimous';
    timeoutMs?: number;         // default: 30_000
  };
  vault?: {
    enabled: boolean;
    defaultTtlMs?: number;      // default: 300_000 (5 min)
    maxTokensPerAgent?: number; // default: 10
  };
  learning?: {
    enabled: boolean;
    autoAdjustPolicies?: boolean;
    minDataPoints?: number;     // default: 5
    analysisIntervalTasks?: number; // default: 10
  };
}

// ── Reward Evaluation Input ─────────────────────────────────────────

export interface TaskOutcomeForReward {
  success: boolean;
  underBudget: boolean;
  violations: ViolationRecord[];
  selfReported: boolean;
  toolsUsed: string[];
  durationMs: number;
  costUsd: number;
}

// ── Governance Stats ────────────────────────────────────────────────

export interface GovernanceStats {
  totalDecisions: number;
  allowed: number;
  denied: number;
  restricted: number;
  escalated: number;
  agentCount: number;
  averageTrustScore: number;
  activeVaultTokens: number;
  insightsGenerated: number;
  policyAdjustments: number;
}
