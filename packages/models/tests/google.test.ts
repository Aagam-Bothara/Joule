import { describe, it, expect, vi } from 'vitest';
import { ModelTier, MODEL_PRICING } from '@joule/shared';

// Mock @google/generative-ai
vi.mock('@google/generative-ai', () => {
  const mockGenerateContent = vi.fn().mockResolvedValue({
    response: {
      text: () => 'Hello from Gemini!',
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
    },
  });

  const mockGenerateContentStream = vi.fn().mockResolvedValue({
    stream: (async function* () {
      yield { text: () => 'Hello ' };
      yield { text: () => 'from Gemini!' };
    })(),
    response: Promise.resolve({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
    }),
  });

  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
      }),
    })),
  };
});

import { GoogleProvider } from '../src/providers/google.js';

describe('GoogleProvider', () => {
  const provider = new GoogleProvider({
    apiKey: 'test-key',
    slmModel: 'gemini-2.0-flash',
    llmModel: 'gemini-2.5-pro',
  });

  it('has correct name and supported tiers', () => {
    expect(provider.name).toBe('google');
    expect(provider.supportedTiers).toEqual([ModelTier.SLM, ModelTier.LLM]);
  });

  it('reports as available', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('lists SLM and LLM models', async () => {
    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('gemini-2.0-flash');
    expect(models[0].tier).toBe(ModelTier.SLM);
    expect(models[1].id).toBe('gemini-2.5-pro');
    expect(models[1].tier).toBe(ModelTier.LLM);
  });

  it('estimates cost correctly', () => {
    const cost = provider.estimateCost(1_000_000, 'gemini-2.0-flash');
    // Flash: input=$0.10/M + output=$0.40/M = $0.50 per 1M prompt tokens
    expect(cost).toBeCloseTo(0.50, 2);
  });

  it('chat returns a response with token usage', async () => {
    const response = await provider.chat({
      model: 'gemini-2.0-flash',
      provider: 'google',
      tier: ModelTier.SLM,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response.content).toBe('Hello from Gemini!');
    expect(response.provider).toBe('google');
    expect(response.tokenUsage.promptTokens).toBe(10);
    expect(response.tokenUsage.completionTokens).toBe(20);
    expect(response.tokenUsage.totalTokens).toBe(30);
    expect(response.finishReason).toBe('stop');
  });

  it('chatStream yields chunks and final token usage', async () => {
    const chunks = [];
    for await (const chunk of provider.chatStream({
      model: 'gemini-2.0-flash',
      provider: 'google',
      tier: ModelTier.SLM,
      messages: [{ role: 'user', content: 'Hello' }],
    })) {
      chunks.push(chunk);
    }

    // At least content chunks + final chunk
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const finalChunk = chunks[chunks.length - 1];
    expect(finalChunk.done).toBe(true);
    expect(finalChunk.tokenUsage?.totalTokens).toBe(30);
  });

  it('calculates model context windows', async () => {
    const models = await provider.listModels();
    // Gemini models have 1M token context
    expect(models[0].contextWindow).toBe(1_000_000);
    expect(models[1].contextWindow).toBe(1_000_000);
  });
});
