# @joule/shared

Shared types, Zod schemas, constants, and utility functions for the Joule
ecosystem. This package has zero internal dependencies and serves as the
foundation for all other Joule packages.

## Installation

```bash
pnpm add @joule/shared
```

## Key Exports

### Types

- `JouleConfig` -- top-level configuration type
- `BudgetEnvelope` -- budget dimension limits
- `BudgetPresetName` -- `"low" | "medium" | "high" | "unlimited"`
- `Task`, `TaskResult` -- task submission and result types
- `ToolDefinition` -- interface for defining tools
- `EnergyConfig`, `ModelEnergyProfile` -- energy tracking types
- `AuthConfig`, `JouleUser`, `ApiKey` -- authentication types
- `ScheduledTask`, `ScheduleConfig` -- scheduler types
- `VoiceConfig` -- voice interaction types
- `Session` -- session state type

### Schemas

- `taskSubmissionSchema` -- Zod schema for validating task submissions
- `loginRequestSchema` -- Zod schema for login requests
- `registerRequestSchema` -- Zod schema for registration requests

### Constants

- `BUDGET_PRESETS` -- default budget envelopes for `low`, `medium`, `high`, and `unlimited`
- `MODEL_PRICING` -- per-model cost rates (input/output per million tokens)
- `MODEL_ENERGY` -- per-model energy profiles (Wh per million tokens)
- `DEFAULT_ENERGY_CONFIG` -- default energy tracking configuration
- `DEFAULT_CONFIG` -- full default `JouleConfig`

### Utilities

- `generateId(prefix)` -- generate a prefixed unique ID (e.g., `task_abc123`)
- `monotonicNow()` -- high-resolution monotonic timestamp
- `isoNow()` -- current time as ISO 8601 string
- `calculateCost()`, `estimateCost()` -- compute monetary cost from token usage
- `calculateEnergy()`, `estimateEnergy()`, `calculateCarbon()` -- energy and carbon calculations
- `JouleError`, `BudgetExhaustedError`, `ToolNotFoundError`, `ToolExecutionError`, `ProviderNotAvailableError` -- error classes

## Usage

```typescript
import {
  BUDGET_PRESETS,
  generateId,
  type JouleConfig,
  type Task,
} from '@joule/shared';

const taskId = generateId('task');
// => "task_v7k3m9x2p1"

const budget = BUDGET_PRESETS.medium;
// => { maxTokens: 16000, maxLatencyMs: 30000, ... }
```
