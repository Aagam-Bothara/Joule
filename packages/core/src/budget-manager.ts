import {
  type BudgetEnvelope,
  type BudgetPresetName,
  type BudgetUsage,
  type BudgetCheckpoint,
  type TokenUsage,
  type EnergyConfig,
  BudgetExhaustedError,
  monotonicNow,
  calculateEnergy,
  calculateCarbon,
  BUDGET_PRESETS,
  MODEL_PRICING,
} from '@joule/shared';

export interface BudgetEnvelopeInstance {
  id: string;
  envelope: BudgetEnvelope;
  state: BudgetState;
}

interface BudgetState {
  tokensUsed: number;
  toolCallsUsed: number;
  escalationsUsed: number;
  costUsd: number;
  startTime: number;
  energyWh: number;
  carbonGrams: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export class BudgetManager {
  private envelopes = new Map<string, BudgetEnvelopeInstance>();
  private parentMap = new Map<string, BudgetEnvelopeInstance>();
  private nextId = 0;

  createEnvelope(budget?: BudgetPresetName | Partial<BudgetEnvelope>): BudgetEnvelopeInstance {
    const id = `budget_${this.nextId++}`;
    let envelope: BudgetEnvelope;

    if (typeof budget === 'string') {
      envelope = { ...BUDGET_PRESETS[budget] };
    } else if (budget) {
      envelope = { ...BUDGET_PRESETS.medium, ...budget };
    } else {
      envelope = { ...BUDGET_PRESETS.medium };
    }

    const instance: BudgetEnvelopeInstance = {
      id,
      envelope,
      state: {
        tokensUsed: 0,
        toolCallsUsed: 0,
        escalationsUsed: 0,
        costUsd: 0,
        startTime: monotonicNow(),
        energyWh: 0,
        carbonGrams: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    };

    this.envelopes.set(id, instance);
    return instance;
  }

  deductTokens(instance: BudgetEnvelopeInstance, count: number, model: string): void {
    instance.state.tokensUsed += count;
    const pricing = MODEL_PRICING[model];
    if (pricing) {
      // Approximate: split tokens evenly between input/output for deduction
      instance.state.costUsd += (count * (pricing.inputPerMillion + pricing.outputPerMillion) / 2) / 1_000_000;
    }
    // Mirror to parent
    const parent = this.parentMap.get(instance.id);
    if (parent) this.deductTokens(parent, count, model);
  }

  deductCost(instance: BudgetEnvelopeInstance, costUsd: number): void {
    instance.state.costUsd += costUsd;
    const parent = this.parentMap.get(instance.id);
    if (parent) this.deductCost(parent, costUsd);
  }

  deductToolCall(instance: BudgetEnvelopeInstance): void {
    instance.state.toolCallsUsed += 1;
    const parent = this.parentMap.get(instance.id);
    if (parent) this.deductToolCall(parent);
  }

  deductEscalation(instance: BudgetEnvelopeInstance): void {
    instance.state.escalationsUsed += 1;
    const parent = this.parentMap.get(instance.id);
    if (parent) this.deductEscalation(parent);
  }

  deductEnergy(instance: BudgetEnvelopeInstance, model: string, usage: TokenUsage, energyConfig?: EnergyConfig): void {
    const energyWh = calculateEnergy(model, usage);
    instance.state.energyWh += energyWh;
    instance.state.totalInputTokens += usage.promptTokens;
    instance.state.totalOutputTokens += usage.completionTokens;
    if (energyConfig) {
      instance.state.carbonGrams += calculateCarbon(energyWh, model, energyConfig);
    }
    // Mirror to parent
    const parent = this.parentMap.get(instance.id);
    if (parent) this.deductEnergy(parent, model, usage, energyConfig);
  }

  checkBudget(instance: BudgetEnvelopeInstance): void {
    const usage = this.getUsage(instance);

    if (usage.tokensRemaining <= 0) {
      throw new BudgetExhaustedError('tokens', usage);
    }
    if (usage.latencyRemaining <= 0) {
      throw new BudgetExhaustedError('latency', usage);
    }
    if (usage.toolCallsRemaining < 0) {
      throw new BudgetExhaustedError('toolCalls', usage);
    }
    if (usage.escalationsRemaining < 0) {
      throw new BudgetExhaustedError('escalations', usage);
    }
    if (usage.costRemaining < 0) {
      throw new BudgetExhaustedError('cost', usage);
    }
    if (instance.envelope.maxEnergyWh !== undefined &&
        usage.energyRemaining !== undefined &&
        usage.energyRemaining < 0) {
      throw new BudgetExhaustedError('energy', usage);
    }
    if (instance.envelope.maxCarbonGrams !== undefined &&
        usage.carbonRemaining !== undefined &&
        usage.carbonRemaining < 0) {
      throw new BudgetExhaustedError('carbon', usage);
    }
  }

  canAffordEscalation(instance: BudgetEnvelopeInstance): boolean {
    return instance.state.escalationsUsed < instance.envelope.maxEscalations;
  }

  canAffordToolCall(instance: BudgetEnvelopeInstance): boolean {
    return instance.state.toolCallsUsed < instance.envelope.maxToolCalls;
  }

  getUsage(instance: BudgetEnvelopeInstance): BudgetUsage {
    const elapsed = monotonicNow() - instance.state.startTime;
    return {
      tokensUsed: instance.state.tokensUsed,
      tokensRemaining: instance.envelope.maxTokens - instance.state.tokensUsed,
      toolCallsUsed: instance.state.toolCallsUsed,
      toolCallsRemaining: instance.envelope.maxToolCalls - instance.state.toolCallsUsed,
      escalationsUsed: instance.state.escalationsUsed,
      escalationsRemaining: instance.envelope.maxEscalations - instance.state.escalationsUsed,
      costUsd: instance.state.costUsd,
      costRemaining: instance.envelope.costCeilingUsd - instance.state.costUsd,
      elapsedMs: elapsed,
      latencyRemaining: instance.envelope.maxLatencyMs - elapsed,
      energyWh: instance.state.energyWh,
      energyRemaining: instance.envelope.maxEnergyWh !== undefined
        ? instance.envelope.maxEnergyWh - instance.state.energyWh
        : undefined,
      carbonGrams: instance.state.carbonGrams,
      carbonRemaining: instance.envelope.maxCarbonGrams !== undefined
        ? instance.envelope.maxCarbonGrams - instance.state.carbonGrams
        : undefined,
    };
  }

  getEnergyTotals(instance: BudgetEnvelopeInstance): {
    totalInputTokens: number;
    totalOutputTokens: number;
    energyWh: number;
    carbonGrams: number;
  } {
    return {
      totalInputTokens: instance.state.totalInputTokens,
      totalOutputTokens: instance.state.totalOutputTokens,
      energyWh: instance.state.energyWh,
      carbonGrams: instance.state.carbonGrams,
    };
  }

  /**
   * Create a child envelope that shares a fraction of the parent's remaining budget.
   * Deductions on the child are automatically mirrored to the parent via deduct methods.
   */
  createSubEnvelope(parent: BudgetEnvelopeInstance, share: number): BudgetEnvelopeInstance {
    const clampedShare = Math.max(0, Math.min(1, share));
    const remaining = this.getUsage(parent);

    const subEnvelope: BudgetEnvelope = {
      maxTokens: Math.floor(remaining.tokensRemaining * clampedShare),
      maxToolCalls: Math.floor(remaining.toolCallsRemaining * clampedShare),
      maxEscalations: Math.max(1, Math.floor(remaining.escalationsRemaining * clampedShare)),
      costCeilingUsd: remaining.costRemaining * clampedShare,
      maxLatencyMs: remaining.latencyRemaining * clampedShare,
      maxEnergyWh: parent.envelope.maxEnergyWh !== undefined
        ? (remaining.energyRemaining ?? 0) * clampedShare
        : undefined,
      maxCarbonGrams: parent.envelope.maxCarbonGrams !== undefined
        ? (remaining.carbonRemaining ?? 0) * clampedShare
        : undefined,
    };

    const id = `budget_${this.nextId++}`;
    const instance: BudgetEnvelopeInstance = {
      id,
      envelope: subEnvelope,
      state: {
        tokensUsed: 0,
        toolCallsUsed: 0,
        escalationsUsed: 0,
        costUsd: 0,
        startTime: monotonicNow(),
        energyWh: 0,
        carbonGrams: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    };

    this.envelopes.set(id, instance);
    this.parentMap.set(id, parent);
    return instance;
  }

  checkpoint(instance: BudgetEnvelopeInstance, label: string): BudgetCheckpoint {
    return {
      label,
      timestamp: monotonicNow(),
      usage: this.getUsage(instance),
    };
  }
}
