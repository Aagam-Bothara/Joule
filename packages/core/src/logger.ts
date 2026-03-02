/**
 * Structured Logger for Joule.
 *
 * Replaces ad-hoc console.log with level-aware, JSON-structured logging.
 * Supports child loggers with inherited context for tracing across components.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogContext {
  taskId?: string;
  traceId?: string;
  agentId?: string;
  component?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: LogContext;
}

export type LogHandler = (entry: LogEntry) => void;

/** Default handler: structured JSON to stdout */
function defaultHandler(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') {
    console.error(line);
  } else if (entry.level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export class Logger {
  private static instance: Logger | undefined;

  private level: LogLevel = 'info';
  private handlers: LogHandler[] = [];
  private defaultContext: LogContext;
  private useStructured: boolean;

  constructor(options?: { level?: LogLevel; structured?: boolean; context?: LogContext }) {
    this.level = options?.level ?? 'info';
    this.useStructured = options?.structured ?? true;
    this.defaultContext = options?.context ?? {};
    if (this.useStructured) {
      this.handlers.push(defaultHandler);
    }
  }

  /** Get or create the global singleton logger. */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /** Replace the global singleton (useful for testing). */
  static setInstance(logger: Logger): void {
    Logger.instance = logger;
  }

  /** Reset the global singleton. */
  static reset(): void {
    Logger.instance = undefined;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /** Add a custom log handler. */
  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  /** Remove all handlers. */
  clearHandlers(): void {
    this.handlers.length = 0;
  }

  /**
   * Create a child logger with additional default context.
   * The child inherits handlers and level from the parent.
   */
  child(context: LogContext): Logger {
    const child = new Logger({
      level: this.level,
      structured: this.useStructured,
      context: { ...this.defaultContext, ...context },
    });
    child.handlers = [...this.handlers];
    return child;
  }

  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
    };

    const mergedContext = { ...this.defaultContext, ...context };
    if (Object.keys(mergedContext).length > 0) {
      entry.context = mergedContext;
    }

    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch {
        // Never let a log handler crash the application
      }
    }
  }
}
