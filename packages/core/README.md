# @joule/core

Core orchestration engine for Joule. Handles task planning, execution, budget
enforcement, model routing, session management, scheduling, and proactive
triggers.

## Installation

```bash
pnpm add @joule/core
```

## Key Exports

- `Joule` -- main engine class; entry point for all task execution
- `TaskExecutor` -- executes planned steps, dispatches tool calls, handles re-planning
- `BudgetManager` -- tracks and enforces budget limits across seven dimensions
- `ModelRouter` -- routes tasks to SLM or LLM based on complexity scoring
- `Planner` -- generates execution plans (`ExecutionPlan`, `PlanStep`)
- `TraceLogger` -- records execution traces for observability
- `ToolRegistry` -- manages registered tools (built-in, plugin, MCP)
- `ConfigManager` -- loads and merges `joule.config.yaml` with defaults
- `SessionManager` -- manages per-user conversation sessions
- `AgentMemory` -- persistent key-value and episodic memory for agents
- `Scheduler` -- cron-based task scheduler with `matchesCron`, `parseCron`, `validateCron`
- `VoiceEngine` -- speech-to-text and text-to-speech interaction loop
- `ProactiveEngine` -- trigger-based autonomous task execution

### Types

- `ProgressCallback`, `ProgressEvent`, `StreamEvent` -- streaming callback types
- `RoutingDecision`, `RoutingPurpose`, `RoutingContext` -- router types
- `ExecutionPlan`, `PlanStep` -- planner output types
- `VoiceEvent`, `VoiceEventCallback` -- voice engine events
- `ProactiveTrigger`, `ProactiveEvent` -- proactive engine types

## Usage

```typescript
import { Joule } from '@joule/core';
import type { Task } from '@joule/shared';

const joule = new Joule();
// ... register providers and tools via setup ...

const task: Task = {
  id: 'task_001',
  description: 'List all TypeScript files in the project',
  budget: 'low',
  createdAt: new Date().toISOString(),
};

const result = await joule.execute(task);
console.log(result.response);
console.log(`Tokens used: ${result.budgetUsed.tokens}`);
console.log(`Energy: ${result.budgetUsed.energyWh} Wh`);
```
