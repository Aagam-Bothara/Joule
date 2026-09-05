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

---

## Adaptive Execution (SLM-first step agent + escalation policy)

`routing.defaultMode` (default `adaptive`) or `task.mode` selects the execution model. Adaptive replaces the plan-then-execute
pipeline above with a stepwise loop. The small model is the default executor;
a large model is brought in only for the part of the task that needs it.

```
Task
 ↓
StepAgent at the current tier (SLM by default)
 ↓
Execute tool → Observe → Verify (deterministic) → update ExecutionState
 ↓
ConfidenceEngine (evidence only, no self-report)
 ↓
EscalationPolicy
 ├── CONTINUE → same tier keeps working
 ├── CONSULT  → one focused question to the LLM → advice returns to the SLM
 ├── HANDOFF  → LLM takes over from the current state (no restart)
 └── ABORT    → budget / safety / impossible tool requirement
```

### Components (`packages/core/src/adaptive/`)

| Component | Role |
| --- | --- |
| `ExecutionState` (`@joule/shared`) | Single source of truth for a run: goal, versioned plans, completed steps, observations, failures, hypotheses, advice, decisions, budget. Consultations and handoffs are derived from it. |
| `StepAgent` | One model-driven loop, tier as a parameter. Emits exactly one structured action per turn: `tool_call`, `final_answer`, `ask_consult`, or `give_up`. |
| `StepVerifier` | Deterministic checks: `output_check`, `dom_check`, `command_exit`, `test_result`. Command outputs with a non-zero exit code fail verification even when the tool call succeeded. `llm_judge` is opt-in and always labelled. |
| `ConfidenceEngine` | `composite = w·toolSuccess + w·verification + w·progress + w·budgetHeadroom + w·(1−repeatedFailure) − w·repeatedFailure − w·contradiction`. No model self-report enters it. |
| `RuleBasedEscalationPolicy` | Ordered rules: abort hard stops → handoff hard triggers (3 failures, give-up, repeated malformed output, consults exhausted) → consult triggers (same failure twice, verification contradiction, stall, agent asked) → soft thresholds. Every escalation is gated by `BudgetManager.canAfford`; a handoff also consumes an escalation unit. |
| `Consultant` | Builds a `ConsultationRequest` (goal, question, evidence, hypotheses, attempts, constraints, token cap, current file contents) and asks the next rung once. In `patch` mode (default) the reply may carry a concrete file edit that the executor applies before the small model continues; the advice and the applied edit are injected into the SLM's next turn and the following steps carry the `consultId`. |
| Static check | A source file the agent has just written is compile-checked (`py_compile` for Python) before anything else happens. A syntax error goes straight back to the agent with the line, counts as a cheap slip rather than a failure, and only escalates when the same error repeats. |
| Handoff | `HandoffContext` is rendered from the state and becomes the LLM's only prompt; the same `StepAgent` continues at the LLM tier. |
| Trajectory | Every step logs an `escalation_decision` event; the trace carries a per-tier token/cost rollup (`tierUsage`), and `TaskResult.trajectory` is the per-task report used by the benchmarks. |

### Execution modes

| Mode | Behaviour |
| --- | --- |
| `adaptive` | SLM-first with the full policy. Joule's core. |
| `slm-only` | Step agent pinned to the SLM. Never consults or hands off. |
| `llm-only` | Step agent pinned to the LLM. Quality and cost ceiling. |
| `static-router` | The legacy pipeline documented above. Available for comparison; no longer the default. |

Same engine, same tools, same prompts; only the routing strategy changes, which
is what makes `benchmarks/harness` a fair experiment.

### The escalation ladder

Tiers form a ladder: `slm` (default executor), an optional `mid` rung (an efficient large model
such as Gemini Flash or GPT-4o-mini), and `llm` (frontier). Configure the middle rung per
provider with `models.mid`, and its provider order with `routing.providerPriority.mid`.

- CONSULT asks the next rung up; HANDOFF moves execution to the next rung up.
- A reasoning breakdown (repeated unparseable output, or giving up before any step succeeded)
  hands off like any other failure, one rung up. `breakdownSkipsToTop` sends it straight to the
  top rung instead; on real repositories that turned out to be the single largest cost driver,
  because the middle rung resolves a good share of what the small model cannot at a fraction of
  the frontier price.
- Rungs no provider serves are dropped, so a two-model setup behaves exactly as before.
- `routing.escalation.ladder` restricts the rungs (for example `['slm', 'llm']` to compare
  two-tier and three-tier on the same models). `mid-only` pins execution to the middle rung.
- Each handoff consumes one escalation unit from the budget envelope; the `medium` preset
  allows one, `high` allows five.

Why: on the benchmarks, the middle rung resolved almost everything the small model could not,
and the frontier model was rarely needed. Escalating to the frontier directly costs four to
eight times more per rescued task than escalating to the efficient model first.

### Patch-mode consultations

A consultation used to return prose. On short tasks that worked; on long tasks
the small model turned correct advice into an incorrect edit often enough that
most consultations ended in a handoff anyway. In `patch` mode the advisor
answers the question and, when the fix is a code change it can state exactly,
returns the edit itself: a whole-file `content` for small files or one exact
`search`/`replace` pair for large ones. The executor applies it through the
same write tool the agent uses (so sandboxing and tracing apply), the static
check runs on it, and the small model is told the edit is in place and asked
to verify. The applied edit is a step of its own in the trajectory, attributed
to the advisor's tier and the consult id. Edits on files the run has not
touched, or whose search text does not match exactly once, are dropped; the
prose advice still returns. `consultMode: advice` restores the old behaviour.

### Ablation switches

Each design claim has a switch that removes exactly that choice so the
benchmark harness can measure it (`benchmarks/harness/strategies/ablations.ts`):

| Claim | Switch | Harness strategy |
| --- | --- | --- |
| Consult before handoff | `maxConsultations: 0` | `joule-no-consult` |
| Patch-mode consultations | `consultMode: advice` | `joule-advice` |
| Deterministic verification | `verification: none` | `joule-no-verify` |
| No self-reported confidence | `confidenceSource: self-report` | `joule-self-conf` |
| Static checks as evidence | `staticChecks: false` | `joule-no-static` |

The self-report switch asks the agent for a `confidence` number in every action
and uses it as the composite; the evidence sub-signals are still recorded so
the two can be compared decision by decision. The verification switch removes
declared checks, exit-code checks and static checks together.

### What counts as a failure

Long, incremental tasks exposed three ways a naive failure count misreads progress, so the
policy now applies these rules before any threshold:

- **Progress is not failure.** A verification that fails but passes more checks than the
  previous verified attempt ("3/12", then "6/12") is progress and does not count toward the
  failure limit. The confidence engine's progress signal and the stall rule use the same view.
- **A re-observation is not a second failure.** A test run right after a verified write that
  reports the same pass fraction is the same result seen twice; it is collapsed into one attempt
  for the retry budget and the failure count.
- **Recent, not cumulative.** Failures count within a window of the last `failureWindow` steps
  (default 6) of the current rung. Four failures spread over twenty otherwise-progressing steps
  are not "stuck"; three in the last four are.
- **Rung-local after a handoff.** The model that takes over is judged on its own steps,
  failures and consultations; the record of the model it replaced does not trigger its next
  handoff, which would otherwise happen on its first turn.
- **Reading is not progress.** Eight successful steps in a row that neither change a file nor
  verify anything (reads, searches, listings) trigger a consult. On repositories a small model
  can explore for thirty turns without a single failure; the failure-based rules never see it,
  this one does. A consult, a write or a verified step resets the window.
- **A syntax error is a slip, not being stuck.** A static-check failure on a freshly written
  file is excluded from the failure count and from the verification retry budget; the agent
  gets the error line and fixes it. Only the same syntax error twice in a row escalates, through
  the ordinary repeat rule.
