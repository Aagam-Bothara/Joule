import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShutdownManager } from '../src/shutdown-manager.js';

describe('ShutdownManager', () => {
  let manager: ShutdownManager;

  beforeEach(() => {
    manager = new ShutdownManager();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('callback registration and execution', () => {
    it('should execute callbacks in registration order', async () => {
      const order: string[] = [];

      manager.registerCallback('first', async () => { order.push('first'); });
      manager.registerCallback('second', async () => { order.push('second'); });
      manager.registerCallback('third', async () => { order.push('third'); });

      await manager.shutdown();

      expect(order).toEqual(['first', 'second', 'third']);
    });

    it('should continue executing callbacks when one fails', async () => {
      const order: string[] = [];

      manager.registerCallback('first', async () => { order.push('first'); });
      manager.registerCallback('failing', async () => { throw new Error('boom'); });
      manager.registerCallback('third', async () => { order.push('third'); });

      await manager.shutdown();

      expect(order).toEqual(['first', 'third']);
    });
  });

  describe('request tracking', () => {
    it('should track and untrack active requests', () => {
      manager.trackRequest('req-1');
      manager.trackRequest('req-2');
      expect(manager.getActiveRequestCount()).toBe(2);

      manager.untrackRequest('req-1');
      expect(manager.getActiveRequestCount()).toBe(1);
    });

    it('should wait for requests to drain during shutdown', async () => {
      manager.trackRequest('req-1');

      // Untrack after 50ms
      setTimeout(() => manager.untrackRequest('req-1'), 50);

      const start = Date.now();
      await manager.shutdown({ drainTimeoutMs: 5000 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(manager.getActiveRequestCount()).toBe(0);
    });

    it('should force-close after drain timeout', async () => {
      manager.trackRequest('stuck-request');
      // Never untrack — force timeout

      const start = Date.now();
      await manager.shutdown({ drainTimeoutMs: 200 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(manager.getActiveRequestCount()).toBe(0);
    });
  });

  describe('shutdown state', () => {
    it('should report shutting down state', async () => {
      expect(manager.isShuttingDown()).toBe(false);

      const shutdownPromise = manager.shutdown();
      expect(manager.isShuttingDown()).toBe(true);

      await shutdownPromise;
      expect(manager.isShuttingDown()).toBe(true);
    });

    it('should be idempotent — second call is a no-op', async () => {
      const order: string[] = [];
      manager.registerCallback('test', async () => { order.push('called'); });

      await manager.shutdown();
      await manager.shutdown(); // second call

      expect(order).toEqual(['called']); // only called once
    });

    it('should not track new requests during shutdown', async () => {
      const shutdownPromise = manager.shutdown();
      manager.trackRequest('new-req');

      await shutdownPromise;
      expect(manager.getActiveRequestCount()).toBe(0);
    });
  });
});
