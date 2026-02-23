import type { Joule } from './engine.js';
import { generateId, isoNow } from '@joule/shared';
import type { TaskResult } from '@joule/shared';

/**
 * Proactive trigger types that the engine monitors.
 */
export interface ProactiveTrigger {
  id: string;
  name: string;
  type: 'weather' | 'time' | 'system' | 'webhook' | 'custom';
  condition: TriggerCondition;
  action: string; // Task description to execute when triggered
  enabled: boolean;
  cooldownMs: number; // Minimum time between firings
  lastFiredAt?: string;
  fireCount: number;
}

export interface TriggerCondition {
  type: string;
  params: Record<string, unknown>;
}

export interface WeatherCondition extends TriggerCondition {
  type: 'weather';
  params: {
    location: string;
    condition: 'rain' | 'snow' | 'extreme_heat' | 'extreme_cold' | 'storm';
    apiKey?: string; // OpenWeatherMap API key
  };
}

export interface TimeCondition extends TriggerCondition {
  type: 'time';
  params: {
    hour: number;
    minute?: number;
    days?: number[]; // 0=Sun, 6=Sat
  };
}

export interface SystemCondition extends TriggerCondition {
  type: 'system';
  params: {
    metric: 'cpu' | 'memory' | 'disk';
    threshold: number; // percentage (0-100)
    operator: 'above' | 'below';
  };
}

export interface ProactiveEvent {
  triggerId: string;
  triggerName: string;
  message: string;
  result?: TaskResult;
  timestamp: string;
}

export type ProactiveEventCallback = (event: ProactiveEvent) => void;

/**
 * ProactiveEngine monitors conditions and fires triggers automatically.
 * This is the "JARVIS notices things before you do" feature.
 */
export class ProactiveEngine {
  private triggers: ProactiveTrigger[] = [];
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private callback: ProactiveEventCallback | null = null;
  private running = false;

  constructor(
    private joule: Joule,
    private tickIntervalMs = 60_000, // check every minute
  ) {}

  /**
   * Add a proactive trigger.
   */
  addTrigger(trigger: Omit<ProactiveTrigger, 'id' | 'fireCount'>): string {
    const id = generateId('trigger');
    this.triggers.push({
      ...trigger,
      id,
      fireCount: 0,
    });
    return id;
  }

  /**
   * Remove a trigger by ID.
   */
  removeTrigger(id: string): boolean {
    const idx = this.triggers.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.triggers.splice(idx, 1);
    return true;
  }

  /**
   * List all triggers.
   */
  listTriggers(): ProactiveTrigger[] {
    return [...this.triggers];
  }

  /**
   * Start the proactive engine.
   */
  start(callback: ProactiveEventCallback): void {
    this.callback = callback;
    this.running = true;
    this.tickInterval = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  /**
   * Stop the proactive engine.
   */
  stop(): void {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.callback = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Main tick — check all triggers.
   */
  async tick(): Promise<void> {
    const now = new Date();
    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue;

      // Check cooldown
      if (trigger.lastFiredAt) {
        const elapsed = now.getTime() - new Date(trigger.lastFiredAt).getTime();
        if (elapsed < trigger.cooldownMs) continue;
      }

      const shouldFire = await this.evaluateCondition(trigger.condition, now);
      if (shouldFire) {
        await this.fireTrigger(trigger);
      }
    }
  }

  /**
   * Evaluate a trigger condition.
   */
  async evaluateCondition(condition: TriggerCondition, now: Date): Promise<boolean> {
    switch (condition.type) {
      case 'weather':
        return this.checkWeather(condition as WeatherCondition);
      case 'time':
        return this.checkTime(condition as TimeCondition, now);
      case 'system':
        return this.checkSystem(condition as SystemCondition);
      default:
        return false;
    }
  }

  /**
   * Check weather condition via OpenWeatherMap API.
   */
  async checkWeather(condition: WeatherCondition): Promise<boolean> {
    const { location, condition: weatherType, apiKey } = condition.params;
    if (!apiKey) return false;

    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(location)}&appid=${apiKey}&units=metric`;
      const response = await fetch(url);
      if (!response.ok) return false;

      const data = await response.json() as any;
      const weatherMain = data.weather?.[0]?.main?.toLowerCase() || '';
      const temp = data.main?.temp ?? 20;

      switch (weatherType) {
        case 'rain': return weatherMain === 'rain' || weatherMain === 'drizzle';
        case 'snow': return weatherMain === 'snow';
        case 'storm': return weatherMain === 'thunderstorm';
        case 'extreme_heat': return temp > 38;
        case 'extreme_cold': return temp < -10;
        default: return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Check time-based condition.
   */
  checkTime(condition: TimeCondition, now: Date): boolean {
    const { hour, minute, days } = condition.params;

    if (days && !days.includes(now.getDay())) return false;
    if (now.getHours() !== hour) return false;
    if (minute !== undefined && now.getMinutes() !== minute) return false;

    return true;
  }

  /**
   * Check system resource condition.
   */
  async checkSystem(condition: SystemCondition): Promise<boolean> {
    const { metric, threshold, operator } = condition.params;
    const os = await import('node:os');

    let value = 0;

    switch (metric) {
      case 'cpu': {
        const cpus = os.cpus();
        const total = cpus.reduce((acc, cpu) => {
          const times = cpu.times;
          return acc + times.user + times.nice + times.sys + times.irq + times.idle;
        }, 0);
        const idle = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0);
        value = ((total - idle) / total) * 100;
        break;
      }
      case 'memory': {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        value = ((totalMem - freeMem) / totalMem) * 100;
        break;
      }
      case 'disk': {
        // Simple disk check — report memory usage as proxy on systems without df
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        value = ((totalMem - freeMem) / totalMem) * 100;
        break;
      }
    }

    return operator === 'above' ? value > threshold : value < threshold;
  }

  /**
   * Fire a trigger — execute the associated task.
   */
  private async fireTrigger(trigger: ProactiveTrigger): Promise<void> {
    trigger.lastFiredAt = isoNow();
    trigger.fireCount++;

    const event: ProactiveEvent = {
      triggerId: trigger.id,
      triggerName: trigger.name,
      message: `Proactive trigger "${trigger.name}" fired`,
      timestamp: isoNow(),
    };

    try {
      const task = {
        id: generateId('proactive'),
        description: trigger.action,
        budget: 'low' as const,
        messages: [],
        createdAt: isoNow(),
      };

      let result: TaskResult | undefined;
      for await (const streamEvent of this.joule.executeStream(task)) {
        if (streamEvent.type === 'result' && streamEvent.result) {
          result = streamEvent.result;
        }
      }

      event.result = result;
      event.message = result?.result
        ? `[${trigger.name}] ${result.result}`
        : `Proactive trigger "${trigger.name}" completed`;
    } catch (err) {
      event.message = `Proactive trigger "${trigger.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    this.callback?.(event);
  }
}
