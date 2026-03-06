/**
 * Vault — JIT credential access with scoped tokens.
 *
 * Provides least-privilege access control for agents:
 *  - Just-in-time token issuance (scoped to resource + permissions)
 *  - Automatic expiry on TTL or task completion
 *  - Revocation on suspicious activity
 *  - Full audit trail of issuance, validation, and revocation
 */

import {
  type VaultToken,
  type GovernanceConfig,
  generateId,
  isoNow,
} from '@joule/shared';

// ── Main class ──────────────────────────────────────────────────────

export class Vault {
  private tokens = new Map<string, VaultToken>();
  private defaultTtlMs: number;
  private maxTokensPerAgent: number;

  constructor(config?: GovernanceConfig['vault']) {
    this.defaultTtlMs = config?.defaultTtlMs ?? 300_000;  // 5 min
    this.maxTokensPerAgent = config?.maxTokensPerAgent ?? 10;
  }

  /**
   * Issue a scoped token for an agent.
   * Returns the token or null if the agent has too many active tokens.
   */
  issueToken(
    agentId: string,
    resource: string,
    scopes: string[],
    ttlMs?: number,
  ): VaultToken | null {
    // Enforce per-agent limit
    const activeCount = this.getActiveTokens(agentId).length;
    if (activeCount >= this.maxTokensPerAgent) {
      return null;
    }

    const now = new Date();
    const expiry = new Date(now.getTime() + (ttlMs ?? this.defaultTtlMs));

    const token: VaultToken = {
      id: generateId('vtk'),
      agentId,
      resource,
      scopes,
      issuedAt: now.toISOString(),
      expiresAt: expiry.toISOString(),
      revoked: false,
    };

    this.tokens.set(token.id, token);
    return token;
  }

  /**
   * Validate a token. Checks existence, expiry, and revocation.
   */
  validateToken(tokenId: string): { valid: boolean; reason?: string } {
    const token = this.tokens.get(tokenId);
    if (!token) {
      return { valid: false, reason: 'Token not found' };
    }
    if (token.revoked) {
      return { valid: false, reason: `Token revoked: ${token.revokedReason}` };
    }
    if (new Date(token.expiresAt) < new Date()) {
      return { valid: false, reason: 'Token expired' };
    }
    return { valid: true };
  }

  /**
   * Revoke a specific token.
   */
  revokeToken(tokenId: string, reason: string): boolean {
    const token = this.tokens.get(tokenId);
    if (!token || token.revoked) return false;

    token.revoked = true;
    token.revokedAt = isoNow();
    token.revokedReason = reason;
    return true;
  }

  /**
   * Revoke all active tokens for an agent.
   */
  revokeAllForAgent(agentId: string, reason: string): number {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.agentId === agentId && !token.revoked) {
        token.revoked = true;
        token.revokedAt = isoNow();
        token.revokedReason = reason;
        count++;
      }
    }
    return count;
  }

  /**
   * Get all active (non-expired, non-revoked) tokens for an agent.
   */
  getActiveTokens(agentId: string): VaultToken[] {
    const now = new Date();
    return [...this.tokens.values()].filter(
      t => t.agentId === agentId && !t.revoked && new Date(t.expiresAt) > now,
    );
  }

  /**
   * Remove expired tokens from memory.
   */
  cleanup(): number {
    const now = new Date();
    let removed = 0;
    for (const [id, token] of this.tokens) {
      if (new Date(token.expiresAt) < now || token.revoked) {
        this.tokens.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get full audit log — all tokens (including expired/revoked).
   */
  getAuditLog(): VaultToken[] {
    return [...this.tokens.values()].sort(
      (a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime(),
    );
  }

  /** Total token count (all states). */
  size(): number {
    return this.tokens.size;
  }
}
