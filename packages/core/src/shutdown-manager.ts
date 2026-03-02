/**
 * ShutdownManager — Graceful shutdown orchestrator.
 *
 * Coordinates ordered shutdown: drain in-flight requests, execute
 * registered callbacks (memory flush, scheduler stop, DB close),
 * and handle timeouts for force-shutdown.
 */

export interface ShutdownOptions {
  /** Max time to wait for active requests to drain (default: 30_000ms). */
  drainTimeoutMs?: number;
}

export class ShutdownManager {
  private shutdownInProgress = false;
  private shutdownComplete = false;
  private activeRequests = new Set<string>();
  private callbacks: Array<{ name: string; fn: () => Promise<void> }> = [];

  /** Register a named shutdown callback (executed in registration order). */
  registerCallback(name: string, fn: () => Promise<void>): void {
    this.callbacks.push({ name, fn });
  }

  /** Track an active request (call untrackRequest when done). */
  trackRequest(id: string): void {
    if (this.shutdownInProgress) return;
    this.activeRequests.add(id);
  }

  /** Untrack a completed request. */
  untrackRequest(id: string): void {
    this.activeRequests.delete(id);
  }

  /** Check if shutdown is in progress (used by middleware to reject new requests). */
  isShuttingDown(): boolean {
    return this.shutdownInProgress;
  }

  /** Number of currently active requests. */
  getActiveRequestCount(): number {
    return this.activeRequests.size;
  }

  /**
   * Execute a graceful shutdown:
   * 1. Set shutdownInProgress flag
   * 2. Wait for active requests to drain
   * 3. Execute registered callbacks in order
   * 4. Force-close if drain timeout exceeded
   */
  async shutdown(options?: ShutdownOptions): Promise<void> {
    // Idempotent — don't run twice
    if (this.shutdownComplete) return;
    this.shutdownInProgress = true;

    const drainTimeoutMs = options?.drainTimeoutMs ?? 30_000;

    // Wait for active requests to drain
    if (this.activeRequests.size > 0) {
      await this.waitForDrain(drainTimeoutMs);
    }

    // Execute callbacks in registration order
    for (const { name, fn } of this.callbacks) {
      try {
        await fn();
      } catch (err) {
        // Log but don't fail — continue with remaining callbacks
        console.error(`Shutdown callback '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.shutdownComplete = true;
  }

  private waitForDrain(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const startTime = Date.now();

      const check = () => {
        if (this.activeRequests.size === 0) {
          resolve();
          return;
        }
        if (Date.now() - startTime >= timeoutMs) {
          // Timeout — force proceed
          console.warn(`Shutdown drain timeout: ${this.activeRequests.size} requests still active, proceeding`);
          this.activeRequests.clear();
          resolve();
          return;
        }
        setTimeout(check, 100);
      };

      check();
    });
  }
}
