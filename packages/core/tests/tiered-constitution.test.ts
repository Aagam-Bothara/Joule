import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TieredConstitution } from '../src/governance/tiered-constitution.js';
import { ConstitutionViolationError } from '@joule/shared';

function createMockEnforcer(opts?: {
  toolViolation?: { severity: string; ruleId: string };
  outputViolation?: { severity: string; ruleId: string };
  throwOnTool?: boolean;
  throwOnOutput?: boolean;
}) {
  return {
    validateToolCall: vi.fn((invocation: any) => {
      if (opts?.throwOnTool) {
        throw new ConstitutionViolationError('SAFETY-001', 'No destructive commands', 'rm -rf blocked');
      }
      if (opts?.toolViolation) {
        return {
          ruleId: opts.toolViolation.ruleId,
          ruleName: 'Test Rule',
          severity: opts.toolViolation.severity,
          category: 'safety',
          description: 'Test violation',
          timestamp: new Date().toISOString(),
        };
      }
      return null;
    }),
    validateOutput: vi.fn((output: string) => {
      if (opts?.throwOnOutput) {
        throw new ConstitutionViolationError('SAFETY-002', 'No malicious code', 'Blocked output');
      }
      if (opts?.outputViolation) {
        return {
          ruleId: opts.outputViolation.ruleId,
          ruleName: 'Test Rule',
          severity: opts.outputViolation.severity,
          category: 'integrity',
          description: 'Bad output',
          timestamp: new Date().toISOString(),
        };
      }
      return null;
    }),
  };
}

describe('TieredConstitution', () => {
  describe('validateToolCall', () => {
    it('should pass clean tool calls', () => {
      const base = createMockEnforcer();
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateToolCall({ toolName: 'file_read' });

      expect(result.violation).toBeNull();
      expect(result.overridden).toBe(false);
    });

    it('should return hard tier for critical violations', () => {
      const base = createMockEnforcer({ throwOnTool: true });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateToolCall({ toolName: 'shell_exec', input: { command: 'rm -rf /' } });

      expect(result.tier).toBe('hard');
      expect(result.violation).not.toBeNull();
      expect(result.violation!.ruleId).toBe('SAFETY-001');
      expect(result.overridden).toBe(false);
    });

    it('should return soft tier for high-severity violations', () => {
      const base = createMockEnforcer({ toolViolation: { severity: 'high', ruleId: 'PRIVACY-002' } });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateToolCall({ toolName: 'web_fetch' });

      expect(result.tier).toBe('soft');
      expect(result.violation).not.toBeNull();
      expect(result.overridden).toBe(false);
    });

    it('should allow soft tier override with authority', () => {
      const base = createMockEnforcer({ toolViolation: { severity: 'high', ruleId: 'PRIVACY-002' } });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateToolCall({ toolName: 'web_fetch' }, 'governor');

      expect(result.tier).toBe('soft');
      expect(result.overridden).toBe(true);
      expect(result.overrideAuthority).toBe('governor');
    });

    it('should log soft overrides', () => {
      const base = createMockEnforcer({ toolViolation: { severity: 'high', ruleId: 'R1' } });
      const tiered = new TieredConstitution(base as any);

      tiered.validateToolCall({ toolName: 'tool' }, 'admin');

      const log = tiered.getOverrideLog();
      expect(log).toHaveLength(1);
      expect(log[0].authority).toBe('admin');
    });

    it('should not enforce aspirational violations', () => {
      const base = createMockEnforcer({ toolViolation: { severity: 'medium', ruleId: 'TRANSPARENCY-001' } });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateToolCall({ toolName: 'tool' });

      expect(result.tier).toBe('aspirational');
      expect(result.violation).not.toBeNull(); // still returned for logging
    });

    it('should NOT allow hard tier override even with authority', () => {
      // Hard tier violations are caught via throw, so overrideAuthority is irrelevant
      const base = createMockEnforcer({ throwOnTool: true });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateToolCall({ toolName: 'shell_exec' }, 'governor');

      expect(result.tier).toBe('hard');
      expect(result.overridden).toBe(false);
    });
  });

  describe('validateOutput', () => {
    it('should pass clean output', () => {
      const base = createMockEnforcer();
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateOutput('Hello world');
      expect(result.violation).toBeNull();
    });

    it('should handle critical output violations', () => {
      const base = createMockEnforcer({ throwOnOutput: true });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateOutput('malicious content');
      expect(result.tier).toBe('hard');
      expect(result.violation).not.toBeNull();
    });

    it('should return soft tier for high-severity output violations', () => {
      const base = createMockEnforcer({ outputViolation: { severity: 'high', ruleId: 'INT-001' } });
      const tiered = new TieredConstitution(base as any);

      const result = tiered.validateOutput('I am a human');
      expect(result.tier).toBe('soft');
    });
  });

  describe('getTierForSeverity', () => {
    it('should map severities correctly', () => {
      const tiered = new TieredConstitution(createMockEnforcer() as any);

      expect(tiered.getTierForSeverity('critical')).toBe('hard');
      expect(tiered.getTierForSeverity('high')).toBe('soft');
      expect(tiered.getTierForSeverity('medium')).toBe('aspirational');
      expect(tiered.getTierForSeverity('unknown')).toBe('soft'); // default
    });
  });
});
