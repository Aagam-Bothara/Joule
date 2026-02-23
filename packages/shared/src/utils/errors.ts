import type { BudgetUsage } from '../types/budget.js';

export class JouleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JouleError';
  }
}

export type BudgetDimension = 'tokens' | 'latency' | 'toolCalls' | 'escalations' | 'cost' | 'energy' | 'carbon';

export class BudgetExhaustedError extends JouleError {
  constructor(
    public readonly dimension: BudgetDimension,
    public readonly usage: BudgetUsage,
  ) {
    super(`Budget exhausted: ${dimension}`);
    this.name = 'BudgetExhaustedError';
  }
}

export class ToolNotFoundError extends JouleError {
  constructor(public readonly toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

export class ToolExecutionError extends JouleError {
  constructor(
    public readonly toolName: string,
    public readonly cause: unknown,
  ) {
    super(`Tool execution failed: ${toolName}`);
    this.name = 'ToolExecutionError';
  }
}

export class ProviderNotAvailableError extends JouleError {
  constructor(public readonly providerName: string) {
    super(`Provider not available: ${providerName}`);
    this.name = 'ProviderNotAvailableError';
  }
}

export class PlanValidationError extends JouleError {
  constructor(message: string) {
    super(`Plan validation failed: ${message}`);
    this.name = 'PlanValidationError';
  }
}

export class ConfigError extends JouleError {
  constructor(message: string) {
    super(`Configuration error: ${message}`);
    this.name = 'ConfigError';
  }
}

export class ConstitutionViolationError extends JouleError {
  constructor(
    public readonly ruleId: string,
    public readonly ruleName: string,
    message: string,
  ) {
    super(`Constitution violation [${ruleId}]: ${message}`);
    this.name = 'ConstitutionViolationError';
  }
}
