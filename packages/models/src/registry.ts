import type { ModelProviderName, ModelTier } from '@joule/shared';
import type { ModelProvider } from './provider.js';

export class ModelProviderRegistry {
  private providers = new Map<ModelProviderName, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: ModelProviderName): ModelProvider | undefined {
    return this.providers.get(name);
  }

  async getAvailable(tier: ModelTier): Promise<ModelProvider[]> {
    const available: ModelProvider[] = [];
    for (const provider of this.providers.values()) {
      if (provider.supportedTiers.includes(tier) && await provider.isAvailable()) {
        available.push(provider);
      }
    }
    return available;
  }

  listAll(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  has(name: ModelProviderName): boolean {
    return this.providers.has(name);
  }
}
