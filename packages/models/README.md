# @joule/models

Model provider adapters for Joule. Provides a uniform interface across multiple
LLM providers, with cost and energy estimation per call.

## Installation

```bash
pnpm add @joule/models
```

## Key Exports

### Providers

- `OllamaProvider` -- adapter for local Ollama models
- `AnthropicProvider` -- adapter for Anthropic Claude models
- `OpenAIProvider` -- adapter for OpenAI GPT models

### Base Classes and Registry

- `ModelProvider` -- abstract base class that all providers extend
- `ModelProviderRegistry` -- registry for managing multiple providers
- `StreamChunk` -- type for streaming response chunks

### Pricing and Energy

- `getModelCost(model, inputTokens, outputTokens)` -- compute exact cost
- `estimateModelCost(model, estimatedTokens)` -- estimate cost before execution
- `getModelEnergy(model, inputTokens, outputTokens)` -- compute energy usage in Wh
- `estimateModelEnergy(model, estimatedTokens)` -- estimate energy before execution

Pricing data is sourced from the `MODEL_PRICING` constant in `@joule/shared`,
covering Anthropic, OpenAI, Google, and Ollama models.

## Usage

```typescript
import { OllamaProvider, AnthropicProvider, ModelProviderRegistry } from '@joule/models';

const registry = new ModelProviderRegistry();

// Register a local Ollama provider
registry.register(new OllamaProvider({
  baseUrl: 'http://localhost:11434',
  model: 'llama3.2:3b',
}));

// Register Anthropic for complex tasks
registry.register(new AnthropicProvider({
  apiKey: process.env.JOULE_ANTHROPIC_API_KEY!,
  slmModel: 'claude-haiku-3.5',
  llmModel: 'claude-sonnet-4-20250514',
}));

// Use a provider to generate a response
const provider = registry.get('ollama');
const response = await provider.generate({
  messages: [{ role: 'user', content: 'Hello, world!' }],
});

console.log(response.text);
console.log(`Tokens: ${response.usage.totalTokens}`);
```
