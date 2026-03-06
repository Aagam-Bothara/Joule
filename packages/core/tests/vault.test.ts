import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Vault } from '../src/governance/vault.js';

describe('Vault', () => {
  let vault: Vault;

  beforeEach(() => {
    vi.useFakeTimers();
    vault = new Vault({ enabled: true, defaultTtlMs: 60_000, maxTokensPerAgent: 3 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issueToken', () => {
    it('should issue a token with correct fields', () => {
      const token = vault.issueToken('agent-1', 'database', ['read', 'write']);

      expect(token).not.toBeNull();
      expect(token!.agentId).toBe('agent-1');
      expect(token!.resource).toBe('database');
      expect(token!.scopes).toEqual(['read', 'write']);
      expect(token!.revoked).toBe(false);
    });

    it('should respect custom TTL', () => {
      const token = vault.issueToken('agent-1', 'api', ['call'], 5000);
      const issued = new Date(token!.issuedAt).getTime();
      const expires = new Date(token!.expiresAt).getTime();

      expect(expires - issued).toBe(5000);
    });

    it('should enforce per-agent token limit', () => {
      vault.issueToken('agent-1', 'r1', ['s']);
      vault.issueToken('agent-1', 'r2', ['s']);
      vault.issueToken('agent-1', 'r3', ['s']);
      const fourth = vault.issueToken('agent-1', 'r4', ['s']);

      expect(fourth).toBeNull(); // maxTokensPerAgent = 3
    });

    it('should allow different agents to have their own tokens', () => {
      vault.issueToken('agent-1', 'r1', ['s']);
      vault.issueToken('agent-1', 'r2', ['s']);
      vault.issueToken('agent-1', 'r3', ['s']);
      const otherAgent = vault.issueToken('agent-2', 'r1', ['s']);

      expect(otherAgent).not.toBeNull();
    });
  });

  describe('validateToken', () => {
    it('should validate an active token', () => {
      const token = vault.issueToken('agent-1', 'db', ['read'])!;
      const result = vault.validateToken(token.id);

      expect(result.valid).toBe(true);
    });

    it('should reject unknown tokens', () => {
      const result = vault.validateToken('nonexistent');
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token not found');
    });

    it('should reject revoked tokens', () => {
      const token = vault.issueToken('agent-1', 'db', ['read'])!;
      vault.revokeToken(token.id, 'suspicious');

      const result = vault.validateToken(token.id);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('revoked');
    });

    it('should reject expired tokens', () => {
      const token = vault.issueToken('agent-1', 'db', ['read'], 1000)!;
      vi.advanceTimersByTime(2000);

      const result = vault.validateToken(token.id);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Token expired');
    });
  });

  describe('revokeToken', () => {
    it('should revoke a token and record reason', () => {
      const token = vault.issueToken('agent-1', 'db', ['read'])!;
      const revoked = vault.revokeToken(token.id, 'task complete');

      expect(revoked).toBe(true);
      expect(vault.validateToken(token.id).valid).toBe(false);
    });

    it('should return false for already revoked tokens', () => {
      const token = vault.issueToken('agent-1', 'db', ['read'])!;
      vault.revokeToken(token.id, 'first');
      expect(vault.revokeToken(token.id, 'second')).toBe(false);
    });
  });

  describe('revokeAllForAgent', () => {
    it('should revoke all active tokens for an agent', () => {
      vault.issueToken('agent-1', 'r1', ['s']);
      vault.issueToken('agent-1', 'r2', ['s']);
      vault.issueToken('agent-2', 'r3', ['s']);

      const count = vault.revokeAllForAgent('agent-1', 'cleanup');

      expect(count).toBe(2);
      expect(vault.getActiveTokens('agent-1')).toHaveLength(0);
      expect(vault.getActiveTokens('agent-2')).toHaveLength(1);
    });
  });

  describe('getActiveTokens', () => {
    it('should exclude expired and revoked tokens', () => {
      vault.issueToken('agent-1', 'r1', ['s'], 1000); // will expire
      vault.issueToken('agent-1', 'r2', ['s']);        // active
      const t3 = vault.issueToken('agent-1', 'r3', ['s'])!;
      vault.revokeToken(t3.id, 'revoked');

      vi.advanceTimersByTime(2000); // expire first token

      const active = vault.getActiveTokens('agent-1');
      expect(active).toHaveLength(1);
      expect(active[0].resource).toBe('r2');
    });
  });

  describe('getAuditLog', () => {
    it('should return all tokens sorted newest first', () => {
      vault.issueToken('agent-1', 'r1', ['s']);
      vi.advanceTimersByTime(1000);
      vault.issueToken('agent-1', 'r2', ['s']);

      const log = vault.getAuditLog();
      expect(log).toHaveLength(2);
      expect(log[0].resource).toBe('r2'); // newest
    });
  });
});
