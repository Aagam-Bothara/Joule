import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelTier } from '@joule/shared';

const create = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({ chat: { completions: { create } } })),
}));

import { OpenAIProvider } from '../src/providers/openai.js';

const request = {
  model: 'deepseek/deepseek-v4-flash',
  provider: 'openai' as const,
  tier: ModelTier.LLM,
  messages: [{ role: 'user' as const, content: 'hi' }],
};

/** The shape OpenRouter returns, with the fields under test optional. */
function reply(extra: { cost?: unknown; provider?: unknown } = {}) {
  return {
    choices: [{ message: { content: '{"answer": "ok"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, ...(extra.cost !== undefined ? { cost: extra.cost } : {}) },
    ...(extra.provider !== undefined ? { provider: extra.provider } : {}),
  };
}

describe('OpenAIProvider billing and upstream host', () => {
  const provider = new OpenAIProvider({ apiKey: 'test', baseUrl: 'https://openrouter.ai/api/v1', llmModel: request.model });

  beforeEach(() => create.mockReset());

  it('keeps the billed cost and the serving host when OpenRouter reports them', async () => {
    create.mockResolvedValue(reply({ cost: 0.00042, provider: 'StreamLake' }));
    const r = await provider.chat(request);
    expect(r.billedCostUsd).toBe(0.00042);
    expect(r.costUsd).toBe(0.00042);
    expect(r.upstreamProvider).toBe('StreamLake');
  });

  it('records a reported zero as billed, not as missing', async () => {
    create.mockResolvedValue(reply({ cost: 0, provider: 'OpenInference' }));
    const r = await provider.chat(request);
    expect(r.billedCostUsd).toBe(0);
  });

  it('leaves both fields off when the endpoint reports neither', async () => {
    create.mockResolvedValue(reply());
    const r = await provider.chat(request);
    expect('billedCostUsd' in r).toBe(false);
    expect('upstreamProvider' in r).toBe(false);
    // The estimate is still there, as before.
    expect(typeof r.costUsd).toBe('number');
  });

  it('ignores a cost or host that is not usable', async () => {
    create.mockResolvedValue(reply({ cost: 'free', provider: '  ' }));
    const r = await provider.chat(request);
    expect(r.billedCostUsd).toBeUndefined();
    expect(r.upstreamProvider).toBeUndefined();
  });
});
