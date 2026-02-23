import { describe, it, expect } from 'vitest';

// Inline formatter functions to test (extracted from CLI output patterns)
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatCost(usd: number): string {
  if (usd === 0) return 'free';
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatEnergy(wh: number): string {
  if (wh < 0.001) return `${(wh * 1000).toFixed(2)} mWh`;
  return `${wh.toFixed(4)} Wh`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

describe('Formatting utilities', () => {
  describe('formatDuration', () => {
    it('formats milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('formats seconds', () => {
      expect(formatDuration(2500)).toBe('2.5s');
    });

    it('formats minutes and seconds', () => {
      expect(formatDuration(125000)).toBe('2m 5s');
    });
  });

  describe('formatCost', () => {
    it('formats zero as free', () => {
      expect(formatCost(0)).toBe('free');
    });

    it('formats tiny costs with precision', () => {
      expect(formatCost(0.000123)).toBe('$0.000123');
    });

    it('formats sub-dollar costs', () => {
      expect(formatCost(0.1234)).toBe('$0.1234');
    });

    it('formats dollar amounts', () => {
      expect(formatCost(5.678)).toBe('$5.68');
    });
  });

  describe('formatEnergy', () => {
    it('formats milliwatt-hours', () => {
      expect(formatEnergy(0.0005)).toBe('0.50 mWh');
    });

    it('formats watt-hours', () => {
      expect(formatEnergy(0.0123)).toBe('0.0123 Wh');
    });
  });

  describe('formatTokens', () => {
    it('formats small counts', () => {
      expect(formatTokens(500)).toBe('500');
    });

    it('formats thousands', () => {
      expect(formatTokens(5000)).toBe('5.0k');
    });

    it('formats millions', () => {
      expect(formatTokens(1_500_000)).toBe('1.50M');
    });
  });

  describe('truncate', () => {
    it('preserves short strings', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates long strings with ellipsis', () => {
      expect(truncate('this is a long string', 10)).toBe('this is...');
    });
  });
});
