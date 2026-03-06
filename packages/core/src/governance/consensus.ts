/**
 * ConsensusMechanism — Multi-agent agreement for high-stakes actions.
 *
 * When configured, certain actions require multiple agents to agree before
 * proceeding. Supports two voting modes:
 *  - majority: > 50% must approve
 *  - unanimous: all voters must approve
 *
 * Timeout auto-resolves based on voting mode:
 *  - majority timeout → rejected (default deny)
 *  - unanimous timeout → rejected
 */

import {
  type ConsensusRequest,
  type ConsensusVote,
  type GovernanceConfig,
  generateId,
  isoNow,
} from '@joule/shared';

// ── Main class ──────────────────────────────────────────────────────

export class ConsensusMechanism {
  private requests = new Map<string, ConsensusRequest>();
  private requiredActions: Set<string>;
  private votingMode: 'majority' | 'unanimous';
  private timeoutMs: number;

  constructor(config?: GovernanceConfig['consensus']) {
    this.requiredActions = new Set(config?.requiredFor ?? []);
    this.votingMode = config?.votingMode ?? 'majority';
    this.timeoutMs = config?.timeoutMs ?? 30_000;
  }

  /** Check if an action requires consensus. */
  isActionRequiringConsensus(action: string): boolean {
    return this.requiredActions.has(action);
  }

  /**
   * Create a consensus request for an action.
   * Returns the request with a deadline.
   */
  createRequest(action: string, initiatorAgentId: string, requiredVoters: string[]): ConsensusRequest {
    const now = new Date();
    const deadline = new Date(now.getTime() + this.timeoutMs);

    const request: ConsensusRequest = {
      id: generateId('con'),
      action,
      initiatorAgentId,
      requiredVoters,
      votingMode: this.votingMode,
      votes: [],
      status: 'pending',
      deadline: deadline.toISOString(),
    };

    this.requests.set(request.id, request);
    return request;
  }

  /**
   * Cast a vote on a pending request.
   * Ignores votes from non-required voters or on non-pending requests.
   */
  castVote(requestId: string, vote: ConsensusVote): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') return false;

    // Only required voters can vote
    if (!request.requiredVoters.includes(vote.agentId)) return false;

    // Prevent double voting
    if (request.votes.some(v => v.agentId === vote.agentId)) return false;

    request.votes.push(vote);
    return true;
  }

  /**
   * Resolve a request by tallying votes.
   * Call this after all votes are in or after the deadline.
   */
  resolve(requestId: string): ConsensusRequest {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') {
      return request ?? { id: requestId, action: '', initiatorAgentId: '', requiredVoters: [], votingMode: 'majority', votes: [], status: 'rejected', deadline: '' };
    }

    const approvals = request.votes.filter(v => v.vote === 'approve').length;
    const totalRequired = request.requiredVoters.length;

    if (request.votingMode === 'unanimous') {
      request.status = approvals === totalRequired ? 'approved' : 'rejected';
    } else {
      // Majority
      request.status = approvals > totalRequired / 2 ? 'approved' : 'rejected';
    }

    return request;
  }

  /**
   * Auto-resolve a request due to timeout. Always rejects.
   */
  timeout(requestId: string): ConsensusRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request || request.status !== 'pending') return request;

    request.status = 'timeout';
    return request;
  }

  /**
   * Check if a request has passed its deadline.
   */
  isExpired(requestId: string): boolean {
    const request = this.requests.get(requestId);
    if (!request) return true;
    return new Date(request.deadline) < new Date();
  }

  /** Get all pending requests. */
  getActiveRequests(): ConsensusRequest[] {
    return [...this.requests.values()].filter(r => r.status === 'pending');
  }

  /** Get a specific request. */
  getRequest(requestId: string): ConsensusRequest | undefined {
    return this.requests.get(requestId);
  }

  /** Total request count. */
  size(): number {
    return this.requests.size;
  }
}
