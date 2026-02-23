# Joule System Architecture

This document describes the internal architecture of the Joule project,
including package dependencies, data flow, model routing, budget enforcement,
energy tracking, re-planning, and channel architecture.

---

## Table of Contents

1. [Package Dependency Graph](#package-dependency-graph)
2. [Data Flow](#data-flow)
3. [Budget Enforcement](#budget-enforcement)
4. [Model Routing](#model-routing)
5. [Energy Tracking](#energy-tracking)
6. [Re-planning Loop](#re-planning-loop)
7. [Channel Architecture](#channel-architecture)

---

## Package Dependency Graph

Joule is organized as a monorepo with the following packages:

```
cli ──> core ──> shared
 |       |        ^
 |       |---> models --┘
 |       └---> tools ───┘
 |---> server ──> core
 |---> channels ──> core
 └---> dashboard (React SPA)
```

### Package Descriptions

| Package      | Role                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `shared`     | Constants, type definitions, utility functions. Zero dependencies.    |
| `models`     | Provider adapters (Ollama, Anthropic, OpenAI, Google). Depends on `shared`. |
| `tools`      | Built-in tool implementations and plugin loader. Depends on `shared`. |
| `core`       | Orchestration engine: planner, executor, budget manager, router. Depends on `shared`, `models`, `tools`. |
| `cli`        | Interactive command-line interface. Depends on `core`, `server`, `channels`, `dashboard`. |
| `server`     | HTTP API server (Hono). Depends on `core`.                           |
| `channels`   | Messaging platform integrations (Slack, Discord, etc.). Depends on `core`. |
| `dashboard`  | React single-page application for monitoring and management.         |

### Dependency Rules

- `shared` must never import from any other internal package.
- `models` and `tools` may only import from `shared`.
- `core` may import from `shared`, `models`, and `tools`.
- `server` and `channels` may import from `core` (and transitively from its dependencies).
- `cli` is the top-level entry point and may import from any package.
- `dashboard` is an independent React SPA that communicates with `server` over HTTP.

---

## Data Flow

A task moves through the following stages from submission to result:

```
Task Submission
      |
      v
Complexity Classification
      |
      v
Planning (step generation)
      |
      v
Step Execution (with tool calls)
      |
      |--- step succeeds ---> next step
      |
      |--- step fails ------> Re-planning on failure
      |                              |
      |                              v
      |                        Check budget
      |                              |
      |                        Generate recovery plan
      |                              |
      |                        Re-execute steps
      |
      v
Synthesis (aggregate results)
      |
      v
TaskResult returned to caller
```

### Stage Details

1. **Task Submission** -- The user submits a task description along with optional
   budget and token constraints. This can happen via the CLI, the HTTP API, or a
   messaging channel.

2. **Complexity Classification** -- The router scores the task on a 0-to-1 scale.
   Tasks below the complexity threshold (default 0.6) are routed to a small
   language model (SLM). Tasks at or above the threshold are routed to a large
   language model (LLM).

3. **Planning** -- The selected model generates an execution plan consisting of
   ordered steps. Each step may specify one or more tool calls.

4. **Step Execution** -- The executor runs each step in sequence. Tool calls are
   dispatched to the tool registry, which resolves built-in tools and plugins.

5. **Re-planning on Failure** -- If a step fails, the re-planning loop is
   triggered (see below). The system checks budget headroom before attempting
   recovery.

6. **Synthesis** -- Once all steps complete, the synthesizer aggregates
   intermediate results into a final response.

7. **TaskResult** -- The completed result is returned. It includes the response
   text, execution trace, budget usage, and energy metrics.

---

## Budget Enforcement

Every task is governed by a budget that tracks seven independent dimensions.
When any dimension is exhausted, the system throws a `BudgetExhaustedError`
and halts execution.

### Budget Dimensions

| Dimension         | Unit         | Description                                |
| ----------------- | ------------ | ------------------------------------------ |
| `maxTokens`       | tokens       | Total input + output tokens across all calls |
| `maxCalls`        | count        | Number of model API calls                  |
| `maxSteps`        | count        | Number of execution steps                  |
| `maxTime`         | milliseconds | Wall-clock time for the entire task        |
| `maxCost`         | USD          | Estimated monetary cost of model usage     |
| `maxEnergy`       | Wh           | Energy consumed across all model calls     |
| `maxReplanDepth`  | count        | Maximum number of re-planning attempts     |

### Budget Presets

The configuration supports named presets (`low`, `medium`, `high`, `unlimited`)
that define default values for all seven dimensions. Tasks can reference a preset
by name or supply per-dimension overrides.

### Enforcement Flow

1. Before each model call, the budget manager checks all seven dimensions.
2. If any dimension would be exceeded, a `BudgetExhaustedError` is thrown.
3. After each call completes, actual usage is recorded and the remaining budget
   is updated.
4. Budget state is included in the execution trace for observability.

---

## Model Routing

Joule uses an SLM-first routing strategy to minimize cost and latency.

### Routing Algorithm

1. Classify the incoming task by complexity (score 0.0 to 1.0).
2. If the score is below `complexityThreshold` (default 0.6), route to the
   configured SLM.
3. If the score is at or above the threshold, escalate to the configured LLM.
4. If `preferLocal` is enabled and a local provider (e.g., Ollama) is available,
   prefer the local model when confidence allows.
5. Provider priority is evaluated in order. If the first provider is unavailable
   or returns an error, the next provider in the list is tried.

### Configuration Knobs

- `routing.preferLocal` -- Boolean. Prefer local models over remote.
- `routing.slmConfidenceThreshold` -- Minimum confidence to accept an SLM response
  without escalation.
- `routing.complexityThreshold` -- Score above which the LLM is used (default 0.6).
- `routing.providerPriority` -- Ordered list of provider names.
- `routing.maxReplanDepth` -- Limit on re-planning attempts.

---

## Energy Tracking

Joule tracks energy consumption per model call and optionally includes carbon
estimates in the execution trace.

### How It Works

1. Each model call records its energy usage in watt-hours (Wh).
2. Carbon emissions are estimated as:
   ```
   carbon_gCO2 = energy_Wh * gridCarbonIntensity_gCO2_per_kWh / 1000
   ```
3. Local models use a separate `localModelCarbonIntensity` value that accounts
   for the user's hardware.
4. Energy data is attached to each span in the execution trace.
5. When `energy.includeInRouting` is enabled, the router factors energy cost
   into provider selection using the configured `energyWeight`.

### Configuration

- `energy.enabled` -- Boolean. Enable or disable energy tracking.
- `energy.gridCarbonIntensity` -- gCO2 per kWh for cloud providers.
- `energy.localModelCarbonIntensity` -- gCO2 per kWh for local hardware.
- `energy.includeInRouting` -- Boolean. Factor energy into routing decisions.
- `energy.energyWeight` -- Weight (0.0 to 1.0) given to energy cost during routing.

---

## Re-planning Loop

When a step fails during execution, Joule attempts to recover through
re-planning rather than immediately failing the entire task.

### Re-planning Flow

```
Step failure detected
        |
        v
Check remaining budget (all 7 dimensions)
        |
        |--- budget exhausted ---> throw BudgetExhaustedError
        |
        v
Increment replan depth counter
        |
        |--- depth >= maxReplanDepth ---> throw MaxReplanDepthError
        |
        v
Generate recovery plan (using the current model)
        |
        v
Execute recovery steps
        |
        |--- success ---> continue with original plan
        |
        |--- failure ---> re-enter re-planning loop
```

### Key Behaviors

- The re-planning model receives the original plan, the failed step, and the
  error details as context.
- Each re-planning attempt increments the `replanDepth` counter, which is
  checked against `maxReplanDepth`.
- Budget is checked before every re-planning attempt. If any dimension is
  exhausted, the task terminates.
- Successful recovery merges the recovery plan back into the remaining steps.

---

## Channel Architecture

Channels provide integrations with external messaging platforms. They share a
common architecture built on an abstract base class.

### Class Hierarchy

```
BaseChannel (abstract)
    |
    |---> SlackChannel
    |---> DiscordChannel
    |---> TelegramChannel
    |---> WhatsAppChannel
    |---> SignalChannel
    |---> TeamsChannel
    |---> EmailChannel
    |---> MatrixChannel
    |---> IRCChannel
    |---> TwilioSmsChannel
    └---> WebhookChannel
```

### BaseChannel Contract

Every channel implementation must:

1. Implement `connect()` to establish a connection to the platform.
2. Implement `disconnect()` to cleanly shut down.
3. Implement `onMessage(callback)` to register a handler for incoming messages.
4. Implement `sendResponse(sessionId, message)` to send a reply.
5. Manage sessions: each unique user/thread combination gets its own session,
   which maintains conversation history and budget state.

### Session Management

- A session is created on the first message from a user/thread pair.
- Sessions are keyed by a combination of channel type, user ID, and thread ID.
- Each session holds its own conversation history, budget tracker, and model
  context.
- Sessions expire after a configurable idle timeout.

### Message Flow

```
Platform event (e.g., Slack message)
        |
        v
Channel adapter parses event into normalized Message
        |
        v
Session lookup (create if new)
        |
        v
Message dispatched to core orchestrator
        |
        v
TaskResult returned
        |
        v
Channel adapter formats result for platform
        |
        v
Response sent back to user
```

---

## Summary

Joule's architecture prioritizes cost efficiency (SLM-first routing), resilience
(re-planning on failure), observability (budget tracking and execution traces),
and extensibility (channel adapters and tool plugins). Each package has a clear
responsibility boundary, and dependencies flow in a single direction from leaf
packages (`shared`) up to the entry point (`cli`).
