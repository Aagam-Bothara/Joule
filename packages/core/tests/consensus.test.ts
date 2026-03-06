import { describe, it, expect, beforeEach } from 'vitest';
import { ConsensusMechanism } from '../src/governance/consensus.js';

describe('ConsensusMechanism', () => {
  let consensus: ConsensusMechanism;

  beforeEach(() => {
    consensus = new ConsensusMechanism({
      enabled: true,
      requiredFor: ['shell_exec', 'deploy'],
      votingMode: 'majority',
      timeoutMs: 30_000,
    });
  });

  describe('isActionRequiringConsensus', () => {
    it('should return true for configured actions', () => {
      expect(consensus.isActionRequiringConsensus('shell_exec')).toBe(true);
      expect(consensus.isActionRequiringConsensus('deploy')).toBe(true);
    });

    it('should return false for non-configured actions', () => {
      expect(consensus.isActionRequiringConsensus('file_read')).toBe(false);
    });
  });

  describe('createRequest', () => {
    it('should create a pending request with deadline', () => {
      const req = consensus.createRequest('deploy', 'agent-1', ['agent-2', 'agent-3']);

      expect(req.id).toBeDefined();
      expect(req.action).toBe('deploy');
      expect(req.initiatorAgentId).toBe('agent-1');
      expect(req.requiredVoters).toEqual(['agent-2', 'agent-3']);
      expect(req.status).toBe('pending');
      expect(req.votes).toHaveLength(0);
    });
  });

  describe('castVote', () => {
    it('should accept votes from required voters', () => {
      const req = consensus.createRequest('deploy', 'agent-1', ['agent-2', 'agent-3']);

      const ok = consensus.castVote(req.id, {
        agentId: 'agent-2', vote: 'approve', timestamp: new Date().toISOString(),
      });

      expect(ok).toBe(true);
      expect(consensus.getRequest(req.id)!.votes).toHaveLength(1);
    });

    it('should reject votes from non-required voters', () => {
      const req = consensus.createRequest('deploy', 'agent-1', ['agent-2']);

      const ok = consensus.castVote(req.id, {
        agentId: 'agent-99', vote: 'approve', timestamp: new Date().toISOString(),
      });

      expect(ok).toBe(false);
    });

    it('should prevent double voting', () => {
      const req = consensus.createRequest('deploy', 'agent-1', ['agent-2']);

      consensus.castVote(req.id, { agentId: 'agent-2', vote: 'approve', timestamp: new Date().toISOString() });
      const second = consensus.castVote(req.id, { agentId: 'agent-2', vote: 'reject', timestamp: new Date().toISOString() });

      expect(second).toBe(false);
      expect(consensus.getRequest(req.id)!.votes).toHaveLength(1);
    });

    it('should reject votes on non-pending requests', () => {
      const req = consensus.createRequest('deploy', 'agent-1', ['agent-2']);
      consensus.castVote(req.id, { agentId: 'agent-2', vote: 'approve', timestamp: new Date().toISOString() });
      consensus.resolve(req.id);

      const ok = consensus.castVote(req.id, { agentId: 'agent-2', vote: 'reject', timestamp: new Date().toISOString() });
      expect(ok).toBe(false);
    });
  });

  describe('resolve (majority)', () => {
    it('should approve when majority approves', () => {
      const req = consensus.createRequest('deploy', 'init', ['a1', 'a2', 'a3']);

      consensus.castVote(req.id, { agentId: 'a1', vote: 'approve', timestamp: new Date().toISOString() });
      consensus.castVote(req.id, { agentId: 'a2', vote: 'approve', timestamp: new Date().toISOString() });
      consensus.castVote(req.id, { agentId: 'a3', vote: 'reject', timestamp: new Date().toISOString() });

      const result = consensus.resolve(req.id);
      expect(result.status).toBe('approved');
    });

    it('should reject when majority rejects', () => {
      const req = consensus.createRequest('deploy', 'init', ['a1', 'a2', 'a3']);

      consensus.castVote(req.id, { agentId: 'a1', vote: 'reject', timestamp: new Date().toISOString() });
      consensus.castVote(req.id, { agentId: 'a2', vote: 'reject', timestamp: new Date().toISOString() });
      consensus.castVote(req.id, { agentId: 'a3', vote: 'approve', timestamp: new Date().toISOString() });

      const result = consensus.resolve(req.id);
      expect(result.status).toBe('rejected');
    });
  });

  describe('resolve (unanimous)', () => {
    let unanimousConsensus: ConsensusMechanism;

    beforeEach(() => {
      unanimousConsensus = new ConsensusMechanism({
        enabled: true,
        requiredFor: ['deploy'],
        votingMode: 'unanimous',
        timeoutMs: 30_000,
      });
    });

    it('should approve only when all approve', () => {
      const req = unanimousConsensus.createRequest('deploy', 'init', ['a1', 'a2']);
      consensus.castVote.bind(unanimousConsensus);
      unanimousConsensus.castVote(req.id, { agentId: 'a1', vote: 'approve', timestamp: new Date().toISOString() });
      unanimousConsensus.castVote(req.id, { agentId: 'a2', vote: 'approve', timestamp: new Date().toISOString() });

      expect(unanimousConsensus.resolve(req.id).status).toBe('approved');
    });

    it('should reject if any voter rejects', () => {
      const req = unanimousConsensus.createRequest('deploy', 'init', ['a1', 'a2']);
      unanimousConsensus.castVote(req.id, { agentId: 'a1', vote: 'approve', timestamp: new Date().toISOString() });
      unanimousConsensus.castVote(req.id, { agentId: 'a2', vote: 'reject', timestamp: new Date().toISOString() });

      expect(unanimousConsensus.resolve(req.id).status).toBe('rejected');
    });
  });

  describe('timeout', () => {
    it('should set status to timeout', () => {
      const req = consensus.createRequest('deploy', 'init', ['a1']);
      const result = consensus.timeout(req.id);

      expect(result!.status).toBe('timeout');
    });
  });

  describe('getActiveRequests', () => {
    it('should return only pending requests', () => {
      consensus.createRequest('deploy', 'init', ['a1']);
      const req2 = consensus.createRequest('shell_exec', 'init', ['a1']);
      consensus.timeout(req2.id);

      expect(consensus.getActiveRequests()).toHaveLength(1);
    });
  });
});
