import { describe, it, expect, beforeEach } from 'vitest';
import { ModelTier } from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import { ModelRouter } from '../src/model-router.js';
import { BudgetManager } from '../src/budget-manager.js';

// Mock provider - uses provider.name for registry key
function createMockProvider(name: string, tiers: ModelTier[]) {
  return {
    name,
    supportedTiers: tiers,
    isAvailable: async () => true,
    listModels: async () =>
      tiers.map(tier => ({
        id: `${name}-${tier}`,
        name: `${name} ${tier}`,
        tier,
        contextWindow: 4096,
        maxOutputTokens: 2048,
      })),
    estimateCost: (_tokens: number, _model: string) => 0.001,
    chat: async () => ({
      content: '{}',
      model: `${name}-slm`,
      tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      costUsd: 0.001,
      latencyMs: 100,
    }),
    chatStream: async function* () {
      yield { content: 'test', done: false };
      yield { content: '', done: true, tokenUsage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } };
    },
  };
}

describe('ModelRouter', () => {
  let registry: ModelProviderRegistry;
  let budgetManager: BudgetManager;
  let router: ModelRouter;

  beforeEach(() => {
    registry = new ModelProviderRegistry();
    budgetManager = new BudgetManager();

    // register() takes a ModelProvider (uses provider.name as key)
    registry.register(createMockProvider('ollama', [ModelTier.SLM]) as any);
    registry.register(createMockProvider('anthropic', [ModelTier.SLM, ModelTier.LLM]) as any);

    router = new ModelRouter(registry, budgetManager, {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: {
        slm: ['ollama', 'anthropic'],
        llm: ['anthropic'],
      },
    });
  });

  it('routes classify to SLM', async () => {
    const envelope = budgetManager.createEnvelope('medium');
    const decision = await router.route('classify', envelope);
    expect(decision.tier).toBe(ModelTier.SLM);
    expect(decision.provider).toBe('ollama');
  });

  it('routes verify to SLM', async () => {
    const envelope = budgetManager.createEnvelope('medium');
    const decision = await router.route('verify', envelope);
    expect(decision.tier).toBe(ModelTier.SLM);
  });

  it('routes high complexity to LLM', async () => {
    const envelope = budgetManager.createEnvelope('medium');
    const decision = await router.route('execute', envelope, { complexity: 0.9 });
    expect(decision.tier).toBe(ModelTier.LLM);
    expect(decision.provider).toBe('anthropic');
  });

  it('routes low complexity to SLM', async () => {
    const envelope = budgetManager.createEnvelope('medium');
    const decision = await router.route('execute', envelope, { complexity: 0.3 });
    expect(decision.tier).toBe(ModelTier.SLM);
  });

  it('routes low confidence to LLM', async () => {
    const envelope = budgetManager.createEnvelope('medium');
    const decision = await router.route('synthesize', envelope, { previousConfidence: 0.3 });
    expect(decision.tier).toBe(ModelTier.LLM);
  });

  it('falls back to SLM when no escalation budget', async () => {
    const envelope = budgetManager.createEnvelope({
      maxTokens: 10000,
      maxLatencyMs: 30000,
      maxToolCalls: 5,
      maxEscalations: 0,
      costCeilingUsd: 1.0,
    });
    const decision = await router.route('execute', envelope, { complexity: 0.9 });
    expect(decision.tier).toBe(ModelTier.SLM);
  });

  it('escalation deducts from budget and forces LLM', async () => {
    const envelope = budgetManager.createEnvelope('high');
    const initialEscalations = envelope.state.escalationsUsed;
    const decision = await router.escalate(envelope, 'test escalation');
    expect(decision.tier).toBe(ModelTier.LLM);
    expect(envelope.state.escalationsUsed).toBe(initialEscalations + 1);
  });

  it('includes reason with routing metadata', async () => {
    const envelope = budgetManager.createEnvelope('medium');
    const decision = await router.route('plan', envelope, { complexity: 0.5 });
    expect(decision.reason).toContain('purpose=plan');
    expect(decision.reason).toContain('complexity=0.50');
  });

  it('throws when no provider available for tier', async () => {
    const emptyRegistry = new ModelProviderRegistry();
    const emptyRouter = new ModelRouter(emptyRegistry, budgetManager, {
      preferLocal: true,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: ['ollama'], llm: ['anthropic'] },
    });
    const envelope = budgetManager.createEnvelope('medium');
    await expect(emptyRouter.route('classify', envelope)).rejects.toThrow('No available provider');
  });

  describe('multi-provider auto-switching', () => {
    it('picks cheapest provider when preferEfficientModels is on', async () => {
      const multiRegistry = new ModelProviderRegistry();
      // Google is cheapest SLM ($0.10/$0.40), then OpenAI ($0.15/$0.60), then Anthropic ($0.80/$4.00)
      const cheapProvider = createMockProvider('google', [ModelTier.SLM, ModelTier.LLM]);
      cheapProvider.estimateCost = () => 0.0005; // cheapest
      const midProvider = createMockProvider('openai', [ModelTier.SLM, ModelTier.LLM]);
      midProvider.estimateCost = () => 0.001;
      const expProvider = createMockProvider('anthropic', [ModelTier.SLM, ModelTier.LLM]);
      expProvider.estimateCost = () => 0.005; // most expensive

      multiRegistry.register(cheapProvider as any);
      multiRegistry.register(midProvider as any);
      multiRegistry.register(expProvider as any);

      const efficientRouter = new ModelRouter(multiRegistry, budgetManager, {
        preferLocal: false,
        slmConfidenceThreshold: 0.6,
        complexityThreshold: 0.7,
        preferEfficientModels: true,
        providerPriority: {
          slm: ['google', 'openai', 'anthropic'],
          llm: ['anthropic', 'openai', 'google'],
        },
      });

      const envelope = budgetManager.createEnvelope('medium');
      const decision = await efficientRouter.route('classify', envelope);
      // Google is cheapest SLM and first in priority — should be selected
      expect(decision.provider).toBe('google');
    });

    it('fails over when provider is unavailable', async () => {
      const failoverRegistry = new ModelProviderRegistry();
      const unavailable = createMockProvider('google', [ModelTier.SLM]);
      unavailable.isAvailable = async () => false;
      const available = createMockProvider('anthropic', [ModelTier.SLM, ModelTier.LLM]);

      failoverRegistry.register(unavailable as any);
      failoverRegistry.register(available as any);

      const failoverRouter = new ModelRouter(failoverRegistry, budgetManager, {
        preferLocal: false,
        slmConfidenceThreshold: 0.6,
        complexityThreshold: 0.7,
        providerPriority: {
          slm: ['google', 'anthropic'],
          llm: ['anthropic'],
        },
      });

      const envelope = budgetManager.createEnvelope('medium');
      const decision = await failoverRouter.route('classify', envelope);
      // Google is unavailable, should fall back to anthropic
      expect(decision.provider).toBe('anthropic');
    });

    it('skips providers in failure cooldown', async () => {
      const envelope = budgetManager.createEnvelope('medium');

      // Report 3 failures for ollama
      router.reportFailure('ollama');
      router.reportFailure('ollama');
      router.reportFailure('ollama');

      const decision = await router.route('classify', envelope);
      // ollama should be in cooldown, fall back to anthropic
      expect(decision.provider).toBe('anthropic');
    });

    it('resets failure count on success', async () => {
      const envelope = budgetManager.createEnvelope('medium');

      // Fail 3 times then succeed
      router.reportFailure('ollama');
      router.reportFailure('ollama');
      router.reportFailure('ollama');
      router.reportSuccess('ollama');

      const decision = await router.route('classify', envelope);
      // Success reset the counter, ollama should be available
      expect(decision.provider).toBe('ollama');
    });

    it('includes candidate count in reason when multiple providers available', async () => {
      const multiRegistry = new ModelProviderRegistry();
      multiRegistry.register(createMockProvider('google', [ModelTier.SLM]) as any);
      multiRegistry.register(createMockProvider('anthropic', [ModelTier.SLM, ModelTier.LLM]) as any);

      const multiRouter = new ModelRouter(multiRegistry, budgetManager, {
        preferLocal: false,
        slmConfidenceThreshold: 0.6,
        complexityThreshold: 0.7,
        preferEfficientModels: true,
        providerPriority: {
          slm: ['google', 'anthropic'],
          llm: ['anthropic'],
        },
      });

      const envelope = budgetManager.createEnvelope('medium');
      const decision = await multiRouter.route('classify', envelope);
      expect(decision.reason).toContain('candidates=2');
    });
  });
});
