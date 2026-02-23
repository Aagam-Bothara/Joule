import {
  ModelTier,
  type ModelProviderName,
  type RoutingConfig,
  type EnergyConfig,
  estimateEnergy,
} from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import type { BudgetEnvelopeInstance } from './budget-manager.js';
import type { BudgetManager } from './budget-manager.js';

export type RoutingPurpose = 'classify' | 'plan' | 'execute' | 'synthesize' | 'verify';

export interface RoutingDecision {
  tier: ModelTier;
  provider: ModelProviderName;
  model: string;
  reason: string;
  estimatedCost: number;
  estimatedEnergyWh?: number;
}

export interface RoutingContext {
  complexity?: number;
  previousConfidence?: number;
  energyBudgetRemaining?: number;
}

interface ProviderCandidate {
  provider: ModelProviderName;
  model: string;
  estimatedCost: number;
  estimatedEnergyWh: number;
  score: number;
}

export class ModelRouter {
  // Track provider failures for automatic failover
  private failureCounts = new Map<ModelProviderName, { count: number; lastFailure: number }>();
  private static readonly FAILURE_COOLDOWN_MS = 60_000; // 1 min cooldown after 3 failures
  private static readonly MAX_FAILURES_BEFORE_COOLDOWN = 3;

  constructor(
    private providers: ModelProviderRegistry,
    private budgetManager: BudgetManager,
    private config: RoutingConfig,
    private energyConfig?: EnergyConfig,
  ) {}

  async route(
    purpose: RoutingPurpose,
    envelope: BudgetEnvelopeInstance,
    context?: RoutingContext,
  ): Promise<RoutingDecision> {
    const tier = this.decideTier(purpose, envelope, context);
    const providerPriority = tier === ModelTier.SLM
      ? this.config.providerPriority.slm
      : this.config.providerPriority.llm;

    // Collect all available candidates
    const candidates: ProviderCandidate[] = [];

    for (const providerName of providerPriority) {
      // Skip providers in failure cooldown
      if (this.isInCooldown(providerName)) continue;

      const provider = this.providers.get(providerName);
      if (!provider) continue;
      if (!provider.supportedTiers.includes(tier)) continue;

      const available = await provider.isAvailable();
      if (!available) continue;

      const models = await provider.listModels();
      const model = models.find(m => m.tier === tier);
      if (!model) continue;

      const estimatedCost = provider.estimateCost(1000, model.id);
      const estimatedEnergyWh = estimateEnergy(model.id, 1000, 1000);

      candidates.push({
        provider: providerName,
        model: model.id,
        estimatedCost,
        estimatedEnergyWh,
        score: 0,
      });
    }

    if (candidates.length === 0) {
      throw new Error(`No available provider for tier: ${tier}`);
    }

    // Score and rank candidates
    const best = this.rankCandidates(candidates, purpose, envelope);

    return {
      tier,
      provider: best.provider,
      model: best.model,
      reason: this.buildReason(purpose, tier, best.provider, context, candidates.length),
      estimatedCost: best.estimatedCost,
      estimatedEnergyWh: best.estimatedEnergyWh,
    };
  }

  async escalate(
    envelope: BudgetEnvelopeInstance,
    reason: string,
  ): Promise<RoutingDecision> {
    this.budgetManager.deductEscalation(envelope);

    return this.route('execute', envelope, {
      complexity: 1.0, // Force LLM tier
    });
  }

  /** Report a provider failure for failover tracking */
  reportFailure(provider: ModelProviderName): void {
    const entry = this.failureCounts.get(provider) ?? { count: 0, lastFailure: 0 };
    entry.count += 1;
    entry.lastFailure = Date.now();
    this.failureCounts.set(provider, entry);
  }

  /** Report a provider success — resets failure counter */
  reportSuccess(provider: ModelProviderName): void {
    this.failureCounts.delete(provider);
  }

  private isInCooldown(provider: ModelProviderName): boolean {
    const entry = this.failureCounts.get(provider);
    if (!entry) return false;
    if (entry.count < ModelRouter.MAX_FAILURES_BEFORE_COOLDOWN) return false;
    // In cooldown if last failure was recent
    return (Date.now() - entry.lastFailure) < ModelRouter.FAILURE_COOLDOWN_MS;
  }

  /**
   * Rank candidates by a weighted score:
   * - Cost weight (lower is better)
   * - Energy weight (lower is better, if energy tracking enabled)
   * - Priority weight (earlier in config list = higher priority)
   * - Budget-remaining weight (if budget is tight, strongly prefer cheapest)
   */
  private rankCandidates(
    candidates: ProviderCandidate[],
    purpose: RoutingPurpose,
    envelope: BudgetEnvelopeInstance,
  ): ProviderCandidate {
    // If only one candidate or cost optimization is off, use first (priority-ordered)
    if (candidates.length === 1 || !this.config.preferEfficientModels) {
      return candidates[0];
    }

    const usage = this.budgetManager.getUsage(envelope);
    const budgetTightness = usage.costRemaining > 0
      ? 1 - (usage.costRemaining / (usage.costUsd + usage.costRemaining))
      : 0;

    const energyWeight = this.energyConfig?.enabled
      ? (this.energyConfig.energyWeight ?? 0.3)
      : 0;
    const costWeight = 0.5 + budgetTightness * 0.3; // 0.5-0.8 based on budget pressure
    const priorityWeight = 1.0 - costWeight - energyWeight;

    // Normalize costs and energy across candidates
    const maxCost = Math.max(...candidates.map(c => c.estimatedCost), 0.001);
    const maxEnergy = Math.max(...candidates.map(c => c.estimatedEnergyWh), 0.001);

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const costScore = 1 - (c.estimatedCost / maxCost);         // lower cost = higher score
      const energyScore = 1 - (c.estimatedEnergyWh / maxEnergy); // lower energy = higher score
      const priorityScore = 1 - (i / candidates.length);          // earlier = higher score

      c.score = costWeight * costScore
              + energyWeight * energyScore
              + Math.max(priorityWeight, 0) * priorityScore;
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0];
  }

  private decideTier(
    purpose: RoutingPurpose,
    envelope: BudgetEnvelopeInstance,
    context?: RoutingContext,
  ): ModelTier {
    // Rule 1: classify and verify always use SLM
    if (purpose === 'classify' || purpose === 'verify') {
      return ModelTier.SLM;
    }

    // Rule 2: No escalation budget left = SLM only
    if (!this.budgetManager.canAffordEscalation(envelope)) {
      return ModelTier.SLM;
    }

    // Rule 2.5: Energy budget critically low = prefer SLM
    if (this.energyConfig?.includeInRouting &&
        context?.energyBudgetRemaining !== undefined &&
        context.energyBudgetRemaining < 0.01) {
      return ModelTier.SLM;
    }

    // Rule 3: High complexity = LLM
    if (context?.complexity !== undefined && context.complexity > this.config.complexityThreshold) {
      return ModelTier.LLM;
    }

    // Rule 4: Low confidence from previous step = LLM
    if (context?.previousConfidence !== undefined && context.previousConfidence < this.config.slmConfidenceThreshold) {
      return ModelTier.LLM;
    }

    // Rule 5: Default to SLM
    return ModelTier.SLM;
  }

  private buildReason(
    purpose: RoutingPurpose,
    tier: ModelTier,
    provider: ModelProviderName,
    context?: RoutingContext,
    candidateCount?: number,
  ): string {
    const parts: string[] = [`purpose=${purpose}`, `tier=${tier}`, `provider=${provider}`];
    if (context?.complexity !== undefined) {
      parts.push(`complexity=${context.complexity.toFixed(2)}`);
    }
    if (context?.previousConfidence !== undefined) {
      parts.push(`prevConfidence=${context.previousConfidence.toFixed(2)}`);
    }
    if (candidateCount && candidateCount > 1) {
      parts.push(`candidates=${candidateCount}`);
    }
    return parts.join(', ');
  }
}
