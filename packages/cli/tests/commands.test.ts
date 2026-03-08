/**
 * CLI command tests — test command logic without executing real LLM calls.
 */

import { describe, it, expect } from 'vitest';

// ── Init Wizard ──────────────────────────────────────────────────────────────

describe('Init Wizard', () => {
  it('should export wizard functions', async () => {
    const mod = await import('../src/commands/init-wizard.js');
    expect(typeof mod.runWizard).toBe('function');
    expect(typeof mod.wizardToConfig).toBe('function');
    expect(typeof mod.getCrewTemplateName).toBe('function');
    expect(typeof mod.validateApiKeyFormat).toBe('function');
  });

  it('wizardToConfig: anthropic + advanced → high budget + governance', async () => {
    const { wizardToConfig } = await import('../src/commands/init-wizard.js');
    const config = wizardToConfig({
      provider: 'anthropic',
      useCase: 'code-review',
      complexity: 'advanced',
    });
    expect(config.providers.anthropic.enabled).toBe(true);
    expect(config.providers.ollama).toBe(false);
    expect(config.budget).toBe('high');
    expect(config.governance).toBe(true);
    expect(config.preferLocal).toBe(false);
  });

  it('wizardToConfig: ollama + simple → low budget + local', async () => {
    const { wizardToConfig } = await import('../src/commands/init-wizard.js');
    const config = wizardToConfig({
      provider: 'ollama',
      useCase: 'general',
      complexity: 'simple',
    });
    expect(config.providers.ollama).toBe(true);
    expect(config.budget).toBe('low');
    expect(config.governance).toBe(false);
    expect(config.preferLocal).toBe(true);
  });

  it('wizardToConfig: google + standard → medium budget', async () => {
    const { wizardToConfig } = await import('../src/commands/init-wizard.js');
    const config = wizardToConfig({
      provider: 'google',
      useCase: 'research',
      complexity: 'standard',
    });
    expect(config.providers.google.enabled).toBe(true);
    expect(config.budget).toBe('medium');
    expect(config.governance).toBe(false);
  });

  it('wizardToConfig: should include API key when provided', async () => {
    const { wizardToConfig } = await import('../src/commands/init-wizard.js');
    const config = wizardToConfig({
      provider: 'openai',
      apiKey: 'sk-test123',
      useCase: 'general',
      complexity: 'standard',
    });
    expect(config.providers.openai.enabled).toBe(true);
    expect(config.providers.openai.apiKey).toBe('sk-test123');
    expect(config.providers.anthropic.apiKey).toBeUndefined();
  });

  it('getCrewTemplateName: maps use cases to templates', async () => {
    const { getCrewTemplateName } = await import('../src/commands/init-wizard.js');
    expect(getCrewTemplateName('code-review')).toBe('CODE_REVIEW_CREW');
    expect(getCrewTemplateName('research')).toBe('RESEARCH_CREW');
    expect(getCrewTemplateName('content')).toBe('CONTENT_CREW');
    expect(getCrewTemplateName('general')).toBeNull();
    expect(getCrewTemplateName('custom')).toBeNull();
  });

  it('validateApiKeyFormat: validates provider-specific formats', async () => {
    const { validateApiKeyFormat } = await import('../src/commands/init-wizard.js');

    // Anthropic
    expect(validateApiKeyFormat('anthropic', 'sk-ant-abc123xyz')).toBe(true);
    expect(validateApiKeyFormat('anthropic', 'bad')).toBe(false);
    expect(validateApiKeyFormat('anthropic', 'sk-abc123xyz')).toBe(false); // not sk-ant-

    // OpenAI
    expect(validateApiKeyFormat('openai', 'sk-abc123xyz456')).toBe(true);
    expect(validateApiKeyFormat('openai', 'short')).toBe(false);

    // Google
    expect(validateApiKeyFormat('google', 'AIzaSyAwNrw5-7y3kW1D')).toBe(true);
    expect(validateApiKeyFormat('google', 'tiny')).toBe(false);

    // Unknown provider (accepts any >= 10 chars)
    expect(validateApiKeyFormat('other', '1234567890')).toBe(true);
    expect(validateApiKeyFormat('other', 'short')).toBe(false);
  });
});

// ── Diff Formatter ───────────────────────────────────────────────────────────

describe('Diff Formatter', () => {
  it('should export formatReplayDiff and formatReplayDiffJson', async () => {
    const mod = await import('../src/output/diff-formatter.js');
    expect(typeof mod.formatReplayDiff).toBe('function');
    expect(typeof mod.formatReplayDiffJson).toBe('function');
  });

  it('should format a diff with changed output', async () => {
    const { formatReplayDiff } = await import('../src/output/diff-formatter.js');
    const diff = {
      outputChanged: true,
      outputDiff: ['- old line', '+ new line', '  same line'],
      budgetComparison: {
        originalTokens: 100,
        replayTokens: 150,
        originalCost: 0.001,
        replayCost: 0.002,
        tokenDelta: 50,
        costDelta: 0.001,
      },
      stepComparison: {
        originalStepCount: 2,
        replayStepCount: 3,
        toolsAdded: ['new_tool'],
        toolsRemoved: [],
      },
    };

    const output = formatReplayDiff(diff);
    expect(output).toContain('Replay Diff');
    expect(output).toContain('Budget Comparison');
    expect(output).toContain('100');
    expect(output).toContain('150');
    expect(output).toContain('+ new line');
    expect(output).toContain('- old line');
    expect(output).toContain('new_tool');
  });

  it('should format identical output diff', async () => {
    const { formatReplayDiff } = await import('../src/output/diff-formatter.js');
    const diff = {
      outputChanged: false,
      outputDiff: ['  same line'],
      budgetComparison: {
        originalTokens: 100,
        replayTokens: 100,
        originalCost: 0.001,
        replayCost: 0.001,
        tokenDelta: 0,
        costDelta: 0,
      },
      stepComparison: {
        originalStepCount: 1,
        replayStepCount: 1,
        toolsAdded: [],
        toolsRemoved: [],
      },
    };

    const output = formatReplayDiff(diff);
    expect(output).toContain('identical output');
  });

  it('should format diff as JSON', async () => {
    const { formatReplayDiffJson } = await import('../src/output/diff-formatter.js');
    const diff = {
      outputChanged: true,
      outputDiff: [],
      budgetComparison: {
        originalTokens: 0, replayTokens: 0,
        originalCost: 0, replayCost: 0,
        tokenDelta: 0, costDelta: 0,
      },
      stepComparison: {
        originalStepCount: 0, replayStepCount: 0,
        toolsAdded: [], toolsRemoved: [],
      },
    };

    const json = formatReplayDiffJson(diff);
    const parsed = JSON.parse(json);
    expect(parsed.outputChanged).toBe(true);
  });
});

// ── CLI Output Formatter ─────────────────────────────────────────────────────

describe('CLI Formatter', () => {
  it('should export formatting functions', async () => {
    const mod = await import('../src/output/formatter.js');
    expect(typeof mod.formatResult).toBe('function');
    expect(typeof mod.formatTrace).toBe('function');
    expect(typeof mod.formatProgressLine).toBe('function');
    expect(typeof mod.formatBudgetSummary).toBe('function');
  });
});

// ── Command Exports ──────────────────────────────────────────────────────────

describe('Command Exports', () => {
  it('should export initCommand', async () => {
    const { initCommand } = await import('../src/commands/init.js');
    expect(initCommand).toBeDefined();
    expect(initCommand.name()).toBe('init');
  });

  it('should export replayCommand', async () => {
    const { replayCommand } = await import('../src/commands/replay.js');
    expect(replayCommand).toBeDefined();
    expect(replayCommand.name()).toBe('replay');
  });
});
