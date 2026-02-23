import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProactiveEngine, type ProactiveEvent, type TimeCondition, type SystemCondition } from '../src/proactive.js';

describe('ProactiveEngine', () => {
  let engine: ProactiveEngine;
  let mockJoule: any;

  beforeEach(() => {
    mockJoule = {
      executeStream: vi.fn().mockImplementation(async function* () {
        yield {
          type: 'result',
          result: {
            taskId: 'proactive-1',
            result: 'Proactive result',
            budgetUsed: {
              tokensUsed: 20,
              energyWh: 0.0002,
              carbonGrams: 0.0001,
              costUsd: 0.0005,
              elapsedMs: 100,
            },
          },
        };
      }),
    };

    engine = new ProactiveEngine(mockJoule, 60_000);
  });

  afterEach(() => {
    engine.stop();
  });

  describe('trigger management', () => {
    it('should add a trigger and return its ID', () => {
      const id = engine.addTrigger({
        name: 'Morning check',
        type: 'time',
        condition: { type: 'time', params: { hour: 9 } },
        action: 'Check system status',
        enabled: true,
        cooldownMs: 3600_000,
      });

      expect(id).toBeTruthy();
      expect(id).toMatch(/^trigger[_-]/);
    });

    it('should list triggers', () => {
      engine.addTrigger({
        name: 'Trigger A',
        type: 'time',
        condition: { type: 'time', params: { hour: 9 } },
        action: 'Task A',
        enabled: true,
        cooldownMs: 60_000,
      });

      engine.addTrigger({
        name: 'Trigger B',
        type: 'system',
        condition: { type: 'system', params: { metric: 'cpu', threshold: 80, operator: 'above' } },
        action: 'Task B',
        enabled: true,
        cooldownMs: 60_000,
      });

      const triggers = engine.listTriggers();
      expect(triggers).toHaveLength(2);
      expect(triggers[0].name).toBe('Trigger A');
      expect(triggers[1].name).toBe('Trigger B');
    });

    it('should remove a trigger', () => {
      const id = engine.addTrigger({
        name: 'To remove',
        type: 'time',
        condition: { type: 'time', params: { hour: 9 } },
        action: 'Task',
        enabled: true,
        cooldownMs: 60_000,
      });

      expect(engine.removeTrigger(id)).toBe(true);
      expect(engine.listTriggers()).toHaveLength(0);
    });

    it('should return false when removing nonexistent trigger', () => {
      expect(engine.removeTrigger('nonexistent')).toBe(false);
    });
  });

  describe('time condition', () => {
    it('should match current hour', () => {
      const now = new Date(2024, 0, 15, 9, 0, 0); // Monday 9:00 AM
      const condition: TimeCondition = {
        type: 'time',
        params: { hour: 9 },
      };

      expect(engine.checkTime(condition, now)).toBe(true);
    });

    it('should not match different hour', () => {
      const now = new Date(2024, 0, 15, 10, 0, 0); // 10:00 AM
      const condition: TimeCondition = {
        type: 'time',
        params: { hour: 9 },
      };

      expect(engine.checkTime(condition, now)).toBe(false);
    });

    it('should match specific minute', () => {
      const now = new Date(2024, 0, 15, 9, 30, 0);
      const condition: TimeCondition = {
        type: 'time',
        params: { hour: 9, minute: 30 },
      };

      expect(engine.checkTime(condition, now)).toBe(true);
    });

    it('should filter by day of week', () => {
      const monday = new Date(2024, 0, 15, 9, 0, 0); // Monday = 1
      const condition: TimeCondition = {
        type: 'time',
        params: { hour: 9, days: [1, 3, 5] }, // Mon, Wed, Fri
      };

      expect(engine.checkTime(condition, monday)).toBe(true);

      const tuesday = new Date(2024, 0, 16, 9, 0, 0); // Tuesday = 2
      expect(engine.checkTime(condition, tuesday)).toBe(false);
    });
  });

  describe('system condition', () => {
    it('should check memory above threshold', async () => {
      const condition: SystemCondition = {
        type: 'system',
        params: { metric: 'memory', threshold: 0, operator: 'above' },
      };

      // Memory usage is always > 0%
      const result = await engine.checkSystem(condition);
      expect(result).toBe(true);
    });

    it('should check cpu metric exists', async () => {
      const condition: SystemCondition = {
        type: 'system',
        params: { metric: 'cpu', threshold: 100, operator: 'above' },
      };

      // CPU can't be > 100%
      const result = await engine.checkSystem(condition);
      expect(result).toBe(false);
    });
  });

  describe('engine lifecycle', () => {
    it('should start and stop', () => {
      const callback = vi.fn();
      engine.start(callback);

      expect(engine.isRunning).toBe(true);

      engine.stop();
      expect(engine.isRunning).toBe(false);
    });

    it('should fire matching trigger on tick', async () => {
      const events: ProactiveEvent[] = [];
      const callback = (event: ProactiveEvent) => events.push(event);

      const now = new Date();
      engine.addTrigger({
        name: 'Current time trigger',
        type: 'time',
        condition: {
          type: 'time',
          params: { hour: now.getHours(), minute: now.getMinutes() },
        },
        action: 'Do something now',
        enabled: true,
        cooldownMs: 0,
      });

      engine.start(callback);
      await engine.tick();

      expect(events).toHaveLength(1);
      expect(events[0].triggerName).toBe('Current time trigger');
      expect(events[0].result).toBeDefined();
    });

    it('should skip disabled triggers', async () => {
      const events: ProactiveEvent[] = [];

      const now = new Date();
      engine.addTrigger({
        name: 'Disabled trigger',
        type: 'time',
        condition: {
          type: 'time',
          params: { hour: now.getHours(), minute: now.getMinutes() },
        },
        action: 'Disabled',
        enabled: false,
        cooldownMs: 0,
      });

      engine.start((e) => events.push(e));
      await engine.tick();

      expect(events).toHaveLength(0);
    });

    it('should respect cooldown', async () => {
      const events: ProactiveEvent[] = [];
      const now = new Date();

      engine.addTrigger({
        name: 'Cooldown trigger',
        type: 'time',
        condition: {
          type: 'time',
          params: { hour: now.getHours(), minute: now.getMinutes() },
        },
        action: 'Test',
        enabled: true,
        cooldownMs: 3600_000, // 1 hour cooldown
      });

      engine.start((e) => events.push(e));

      await engine.tick();
      expect(events).toHaveLength(1);

      // Second tick should be blocked by cooldown
      await engine.tick();
      expect(events).toHaveLength(1);
    });
  });

  describe('evaluateCondition', () => {
    it('should return false for unknown condition type', async () => {
      const result = await engine.evaluateCondition(
        { type: 'unknown' as any, params: {} },
        new Date(),
      );
      expect(result).toBe(false);
    });
  });
});
