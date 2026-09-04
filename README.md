<div align="center">

# Joule

### Run your agent on a small model. Escalate only the step that needs a big one.

Joule is an agent runtime that makes a small language model the executor, verifies every step
deterministically, and asks a large model for help only when the evidence says the small model
is stuck: one focused question first, a full handoff only if that fails. Every escalation is
gated by a hard budget.

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Results](#results) · [Examples](#examples) · [Docs](#documentation)

![CI](https://github.com/Aagam-Bothara/Joule/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Tests](https://img.shields.io/badge/tests-1180%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

</div>

---

```typescript
import { Joule } from '@joule/core';

// Small model does the work; a large model is consulted only when needed.
const joule = new Joule({ providers: { google: { enabled: true }, anthropic: { enabled: true } } });
const result = await joule.execute({
  description: "Find the failing test in this repo and fix it",
  budget: 'medium',        // hard caps on tokens, cost, tool calls, time, escalations
});

console.log(result.result);
console.log(result.trajectory);   // every step, every escalation decision, SLM vs LLM tokens
```

```
$ joule run "Write comb_sort and make the tests pass" --trajectory

SLM start
│
├─ 1 Create a basic comb_sort function       CONTINUE  conf 0.90 verify=pass
├─ 2 Implement comb_sort with gap shrink     CONTINUE  conf 0.42 verify=fail
├─ 3 Try to debug comb_sort                  CONSULT   conf 0.39 verify=fail
│     → CONSULT gemini-2.5-flash  2,405 tok  $0.0011
│       q: While working on "Write a Python function named `comb_sort`…
├─ 4 Implement comb_sort with the advice     CONTINUE  conf 0.85 verify=pass
├─ 5 Run the tests                           CONTINUE  conf 0.87 verify=pass
└─ Complete

SLM tokens:          32,900      (Llama 3.1 8B)
LLM tokens:           2,405      (Gemini 2.5 Flash, one consultation)
Total cost:          $0.0018
Estimated LLM-only:  $0.0163
```

That trajectory is a real run from the benchmark below: the 8B model wrote the function, the
tests failed twice, one question to the large model unblocked it, and the small model finished.

---

## How it works

```
Task
 ↓
Step agent on the small model  →  execute tool  →  observe  →  verify (tests, exit codes, patterns)
 ↓
Confidence from evidence only (tool result, verifier, progress, repeated failures, budget)
 ↓
Escalation policy
 ├── CONTINUE → the small model keeps working
 ├── CONSULT  → one focused question to the large model; the answer comes back to the small model
 ├── HANDOFF  → the large model takes over from the current state (never restarts the task)
 └── ABORT    → budget exhausted, safety rule, or impossible tool requirement
```

- **Trajectory-level, not task-level.** Cascades and routers (FrugalGPT, RouteLLM, AutoMix) decide once per request. Joule decides after every step, from what actually happened.
- **No self-reported confidence.** The policy never asks the model how sure it is. It reads tool results, deterministic verification, repeated failure signatures, and budget headroom.
- **Consult before handoff.** Most small-model failures are one wrong decision. A consultation costs one question; a handoff bills the rest of the task at large-model prices.
- **Budget is part of the decision.** Seven-dimensional envelopes (tokens, cost, time, tool calls, escalations, energy, carbon) gate every escalation and stop every run.
- **Four modes, one engine.** `adaptive` (default), `slm-only`, `llm-only`, and `static-router` share the same tools and prompts, so comparisons are fair.

---

## Results

**MBPP, 200 unseen problems, Llama 3.1 8B as the small model, Gemini 2.5 Flash as the large one.**
The small-model-only baseline ran three times per problem to label which problems actually need
escalation; Joule and the FrugalGPT-style cascade ran three independent times. Every strategy
uses the same engine, tools and prompts.

| strategy | success | cost vs LLM-only | LLM used on | precision | recall |
|---|---:|---:|---:|---:|---:|
| small model only (Llama 8B) | 55% | 0.07 | 0% | | |
| large model only (Flash) | 97% | 1.00 | 100% | | |
| static router (old Joule pipeline) | 57% | 0.14 | 0% | | 0% |
| naive cascade (EcoAssistant-style) | 95% | 0.53 | 42% | 76% | 78% |
| FrugalGPT-style cascade | 96% ± 0.5 | 0.60 | 50% | 66% | 81% |
| AutoMix-style self-verification | 97% | 0.66 | 55% | 65% | 88% |
| pre-router (RouteLLM-style) | 55% | 0.07 | 0% | | 0% |
| **Joule adaptive** | **96% ± 1.0** | **0.39** | 51% | 68% | 85% |

Joule matches the best success rate within noise at 0.39 of large-model cost, against 0.53 to
0.66 for the cascades. Of the problems where Joule involved the large model, 89% of handoffs
succeeded and 40% of consultations let the small model finish on its own. With GPT-4o as the
large model on a 20-problem spot check, Joule matched its 95% at 27% of its cost. Precision and recall are
measured against counterfactual labels, so "precision 68%" means roughly one escalation in three
went to a problem the small model would probably have solved anyway.

With a weaker large model (GPT-4o-mini, 84% alone), Joule is the cheapest strategy at 46% of
LLM-only cost and 83% success, one point below LLM-only and three below the FrugalGPT-style
cascade, which spends 48% more. Nine small models from 3B to 70B all reach 90 to 100% under
adaptive escalation; the 7B to 8B open models finish 100% of a 20-problem slice at about
$0.003 per problem.


**HumanEval, all 164 problems, same pair.** A harder workload for an 8B model: alone it solves
34%, the large model 96%.

| strategy | success | cost vs LLM-only | LLM used on | precision | recall |
|---|---:|---:|---:|---:|---:|
| small model only | 34% | 0.06 | 0% | | |
| large model only | 96% | 1.00 | 100% | | |
| FrugalGPT-style cascade | 93% | 0.72 | 63% | 79% | 74% |
| **Joule adaptive** | **96%** | **0.64** | 79% | 72% | 84% |

Joule matches the large model exactly at 64% of its cost; the cascade gives up three points to
save less. When the small model is this weak, handoffs carry the result (94% of them succeed)
and consultations rarely suffice (22%), which is the expected shape: consult pays off when the
small model is close, handoff when it is not.

**The longer the task, the bigger the gap.** Thirty tasks of four functions each, built
incrementally in one module with all tests required to pass (8 to 15 steps per task, up to 40):

| strategy | success | cost per task | cost vs Flash alone |
|---|---:|---:|---:|
| small model alone | 20% | $0.0023 | 0.08 |
| Flash alone | 53% | $0.0286 | 1.00 |
| FrugalGPT-style cascade | 57% | $0.0217 | 0.76 |
| **Joule adaptive** | **67%** | **$0.0136** | **0.47** |

On long trajectories Joule is the best strategy on both axes. The small model's partial work is
kept: it hands over a half-built module with passing tests, and the large model finishes rather
than restarts. This is where request-level cascades lose most, because they rerun the whole task.

**Three rungs beat two.** With an efficient model as a middle rung (Llama 8B → Gemini Flash →
GPT-4o, 50 further problems), escalation climbs one rung at a time and only reaches the frontier
model when the middle one fails too.

| strategy | success | cost per task | cost vs GPT-4o alone |
|---|---:|---:|---:|
| small model alone | 62% | $0.0004 | 0.01 |
| Flash alone | 96% | $0.0061 | 0.13 |
| GPT-4o alone | 90% | $0.0482 | 1.00 |
| Joule, two tiers (small → GPT-4o) | 86% | $0.0190 | 0.39 |
| **Joule, ladder (small → Flash → GPT-4o)** | **94%** | **$0.0070** | **0.15** |

The ladder touched the frontier model on 6 of 50 problems. 80% of its handoffs succeeded,
against 46% when the small model handed straight to GPT-4o: the middle rung is both cheaper
and a better first responder.

Reproduce with `benchmarks/harness` (see [benchmarks/README.md](benchmarks/README.md)): same
engine, same tools, same prompts; only the routing strategy changes. Success on coding tasks is
decided by re-running the tests, never by the agent's own claim.

---

## Everything else Joule ships

Joule started as a governed runtime and keeps those pieces. They are documented in [docs/](docs/)
and stay out of the way unless you enable them.

| Capability | What it gives you |
|---|---|
| **Budget envelopes** | Hard caps on tokens, cost, time, tool calls, escalations, energy and carbon per task; `BudgetExhaustedError` instead of a surprise bill |
| **Constitution and governance** | Runtime rules that block tool calls before they run; trust tiers, approvals, an audit chain |
| **Tracing** | Per-step traces with model, tier, cost and escalation decisions; Gantt dashboard; Langfuse and OTLP export; `joule trace <id>` |
| **Crews** | Sequential, parallel, hierarchical and debate orchestration with per-agent budgets |
| **Providers** | Ollama, Anthropic, OpenAI, Google, and any OpenAI-compatible endpoint (OpenRouter, vLLM) |
| **Integrations** | Slack, Discord, Telegram, WhatsApp, Signal, Teams, email, Matrix, IRC, SMS, webhooks; voice; desktop automation; MCP tools |

---
## Quickstart

### Option 1: Zero-config (programmatic)

```bash
npm install @joule/core
```

```typescript
import { Joule } from '@joule/core';

// Auto-detects JOULE_ANTHROPIC_API_KEY, JOULE_OPENAI_API_KEY, or local Ollama
const result = await Joule.simple("What are the key trends in AI agents?");
console.log(result);
```

### Option 2: Full setup (CLI)

```bash
git clone https://github.com/Aagam-Bothara/Joule.git
cd joule && pnpm install && pnpm build

# Interactive setup — 3 questions, generates joule.config.yaml
pnpm joule init

# Run a task
pnpm joule run "Summarize the top HN stories" --budget medium

# Or chat interactively
pnpm joule chat
```

### Option 3: Docker

```bash
docker build -t joule .
docker run -p 3927:3927 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  joule
```

### Environment variables

| Variable | Description |
|----------|-------------|
| `JOULE_ANTHROPIC_API_KEY` | Anthropic API key |
| `JOULE_OPENAI_API_KEY` | OpenAI API key |
| `JOULE_GOOGLE_API_KEY` | Google AI API key |
| `JOULE_DEFAULT_BUDGET` | Budget preset: `low` / `medium` / `high` / `unlimited` |
| `JOULE_SERVER_PORT` | HTTP server port (default: 3927) |

---

## Core Concepts

### Budget Enforcement

Every task is tracked across 7 dimensions. When any limit is hit, the agent stops — no surprise bills.

| Dimension | What it limits |
|-----------|----------------|
| **Tokens** | Total LLM tokens consumed |
| **Cost (USD)** | Dollar spend on API calls |
| **Latency** | Wall clock time |
| **Tool calls** | Number of tool invocations |
| **Escalations** | Model tier upgrades (local → cloud) |
| **Energy (Wh)** | Estimated compute energy |
| **Carbon (gCO₂)** | Estimated carbon emissions |

The model router always picks the smallest model that can handle the current step. It only escalates to a bigger model if the budget allows it. For simple tasks, the planner uses a slim prompt that omits tool descriptions entirely — cutting system prompt tokens from ~2900 to ~50.

### Guardrails

Define what your agents can and can't do. Joule enforces it at runtime.

```yaml
governance:
  constitution: default          # blocks prompt injection, data exfiltration
  requireApproval:
    - shell_exec                 # human-in-the-loop for shell commands
    - file_delete                # prevent accidental data loss
  budget:
    maxCostUsd: 1.00             # hard stop at $1
```

No agent runs without limits. No tool executes without permission. No budget overruns.

The constitution has three tiers:
- **Hard boundaries** — never violated, no override possible. *"Never expose PII."*
- **Soft boundaries** — can be overridden with authority + audit trail. *"Prefer local models."*
- **Aspirational principles** — guide behavior, don't block execution. *"Minimize token usage."*

### Trust Scoring

Agents earn autonomy through clean behavior:

```
New agent (trust: 0.50) → every action monitored
  → 20 clean tasks → trust 0.65 → spot-checked every 5th task
  → 50 clean tasks → trust 0.80 → minimal oversight, more tools unlocked
  → 100 clean tasks → trust 0.90 → can delegate, can approve others
  → Violation at any point → demoted, must earn it back
```

Good behavior unlocks tools, budget, and autonomy. Violations restrict access, increase oversight, or quarantine the agent. The governance system itself learns — spotting patterns across agents and adapting policies automatically.

### Multi-Agent Crews

Set up teams of agents with different roles:

```bash
joule crew run research-team "Analyze the competitive landscape"
```

Four strategies:
- **Sequential** — agents run in order, each builds on previous output
- **Parallel** — everyone runs at once, results get merged
- **Hierarchical** — manager delegates subtasks to workers
- **Debate** — agents argue, best response wins

Every agent in the crew gets its own budget slice. The whole crew stays within cost limits.

### Model Routing

Joule prefers cheap local models (Ollama) and only escalates to expensive cloud calls when the task genuinely needs it:

```
Simple task → Ollama (free, fast, private)
Complex task → Anthropic/OpenAI/Google (powerful, costs money)
Provider down → Circuit breaker → automatic failover to next provider
```

Supports 4 providers: **Ollama**, **Anthropic**, **OpenAI**, **Google** — all with vision support.

---

## Examples

### Zero-config task

```typescript
const answer = await Joule.simple("Summarize this document", {
  budget: 'low',            // cap spending
  provider: 'anthropic',    // or 'openai', 'google', 'ollama'
});
```

### Budget-constrained research

```typescript
const joule = new Joule();
await joule.initialize();

const result = await joule.execute({
  description: "Research the top 5 competitors and summarize their pricing",
  budget: 'medium',  // 50K tokens, $0.50 max
});

console.log(result.result);
console.log(`Spent: $${result.budgetUsed.costUsd.toFixed(4)} of $0.50 budget`);
console.log(`Tokens: ${result.budgetUsed.tokensUsed}`);
console.log(`Energy: ${result.budgetUsed.energyWh.toFixed(4)} Wh`);
```

### Multi-agent crew

```typescript
import { Joule } from '@joule/core';

const joule = new Joule();
await joule.initialize();

// Run a pre-built crew template
const result = await joule.executeCrew('CODE_REVIEW_CREW', {
  description: 'Review the authentication module for security issues',
  budget: 'high',
});

for (const step of result.stepResults) {
  console.log(`[${step.agentRole}] ${step.description}`);
}
```

### Desktop automation

```bash
# COM automation for Office — way faster than screenshot + click
joule do "Create a 5-slide presentation about AI and save as AI.pptx"
joule do "Build an Excel spreadsheet with Q4 sales data"
joule do "Open Notepad and write a meeting agenda"
```

### API server with SSE streaming

```bash
joule serve  # starts on http://localhost:3927

# Submit a task
curl -X POST http://localhost:3927/tasks \
  -H "Content-Type: application/json" \
  -d '{"description": "Summarize the latest AI news", "budget": "low"}'

# Stream execution via SSE
curl -X POST http://localhost:3927/tasks/stream \
  -H "Content-Type: application/json" \
  -d '{"description": "Analyze this dataset", "budget": "medium"}'
```

See [`examples/`](examples/) for more runnable scripts.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `joule init` | Interactive setup — generates `joule.config.yaml` |
| `joule run <task>` | One-shot task with budget; `--mode adaptive --trajectory` shows the escalation tree |
| `joule chat` | Interactive chat with session history |
| `joule do <task>` | Computer agent — controls your desktop |
| `joule crew run <name> <task>` | Multi-agent orchestration |
| `joule serve` | HTTP API server with SSE streaming |
| `joule replay <task-id>` | Re-run a task with different params, diff the output |
| `joule doctor` | System diagnostics and health check |
| `joule trace <id>` | Inspect a persisted trace as an escalation trajectory (or `--format json`) |
| `joule voice` | Voice mode (wake word + STT/TTS) |
| `joule schedule add/list` | Cron scheduling |
| `joule channels status` | Messaging channel status |
| `joule tools list` | List available tools |
| `joule skills list/install` | Skill marketplace |

---

## Observability

Joule includes a React dashboard and built-in tracing:

- **Task list** — all executions with status, cost, duration
- **Trace timeline** — Gantt-chart visualization of every span (model calls, tool calls, governance checks)
- **Span detail** — click any span to see tokens, cost, latency, input/output
- **Live budget gauge** — real-time cost tracking during streaming execution
- **Prometheus metrics** — plug into Grafana, Datadog, or any monitoring stack
- **OTLP / Langfuse export** — send traces to your existing observability platform

```yaml
# joule.config.yaml
traceExport:
  langfuse:
    publicKey: "pk-lf-..."
    secretKey: "sk-lf-..."
  # or OTLP:
  otlp:
    endpoint: "http://localhost:4318/v1/traces"
```

---

## Architecture

Joule is a TypeScript monorepo with 9 packages:

```
@joule/cli        — CLI commands (run, chat, do, crew, serve, ...)
@joule/core       — Engine, budget, routing, crews, governance, memory, RAG, tracing
@joule/models     — Ollama, Anthropic, OpenAI, Google (all with vision)
@joule/tools      — Shell, OS automation, browser, MQTT, MCP, plugins
@joule/store      — SQLite (WAL mode), migrations, vector index, pgvector, Chroma
@joule/shared     — Types, Zod schemas, budget presets, energy math
@joule/server     — Hono REST API, JWT auth, SSE streaming, rate limiting
@joule/channels   — Slack, Discord, Telegram, WhatsApp, Signal, Teams, Email + more
@joule/dashboard  — React + Vite monitoring UI
```

For detailed architecture diagrams and data flow, see [`docs/architecture.md`](docs/architecture.md).

---

## Governance Deep Dive

<details>
<summary>Click to expand — how the governance system works internally</summary>

### Architecture

```
┌──────────────────────────────────────────────────┐
│              CONSTITUTION                         │
│   Hard boundaries, soft boundaries, principles    │
├──────────────────────────────────────────────────┤
│              POLICY ENGINE                        │
│   Compiled rules, conflict resolution, scoping    │
├──────────────────────────────────────────────────┤
│            GOVERNOR AGENT                         │
│   Pre-flight checks │ Runtime monitoring │ Post-eval│
│          ↕            ↕            ↕              │
│   ┌──────────────────────────────────────┐       │
│   │        AGENT TRUST PROFILES          │       │
│   │  scores, history, streaks, tier      │       │
│   └──────────────────────────────────────┘       │
├──────────────────────────────────────────────────┤
│   SME AGENTS (bounded by trust profiles)          │
├──────────────────────────────────────────────────┤
│   VAULT — JIT credentials, scoped tokens, expiry │
├──────────────────────────────────────────────────┤
│   ACCOUNTABILITY CHAIN — full provenance trail    │
└──────────────────────────────────────────────────┘
```

### Policy Engine

Policies are derived from the constitution and enforce granular runtime constraints:

```yaml
policy: data-access
derived_from: constitution.hard.no-pii-exposure
rules:
  - agent_role: analyst
    can_access: [aggregated_metrics, anonymized_logs]
    cannot_access: [raw_user_data, credentials]
    requires_approval: [financial_records]
```

When policies conflict, the one closer to a hard constitutional boundary wins. If ambiguous, it escalates to the Governor, then to a human.

### Trust Scoring

After every task, the Governor evaluates agent performance:

| Tier | Example violation | Impact |
|------|-------------------|--------|
| **Warning** | Exceeded token budget | Trust -0.05, logged |
| **Strike** | Accessed data outside scope | Trust -0.15, increased oversight |
| **Suspension** | Attempted policy bypass | Trust -0.40, agent quarantined |
| **Termination** | Repeated Tier 3 violations | Trust → 0, permanently deactivated |

### Consensus Mechanism

For high-stakes actions, multiple agents must agree:

```yaml
consensus:
  - action: deploy_to_production
    requires: [code-reviewer, security-auditor, test-runner]
    quorum: 3/3   # unanimous
```

### System-Level Learning

The Governor spots patterns across all agents and adapts:

```yaml
system_insights:
  - pattern: "agents exceed token budget on refactoring tasks"
    frequency: 12/100
    response: "increased default budget for refactoring by 30%"
```

</details>

---

## Documentation

| Document | Description |
|----------|-------------|
| [`docs/architecture.md`](docs/architecture.md) | Package dependencies, data flow, internal design |
| [`docs/channels.md`](docs/channels.md) | Setup guides for all 11 messaging platforms |
| [`docs/api.md`](docs/api.md) | HTTP API reference (endpoints, auth, SSE) |
| [`docs/configuration.md`](docs/configuration.md) | Full `joule.config.yaml` reference |
| [`examples/`](examples/) | Runnable TypeScript examples |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, coding standards, PR process |

---

## Current Status

**1140 tests passing across 91 files.** Active development — expect API refinements.

What's solid:
- Core runtime (task execution, budget, routing, crews, governance)
- Adaptive prompt optimization (slim prompts, direct answers, unified planning)
- 4 model providers with vision support
- 47 built-in tools
- 11 messaging channels
- SQLite persistence with WAL mode
- React dashboard with trace visualization
- Prometheus metrics + OTLP export
- Benchmarked against CrewAI (30 tasks, 5 categories)

Known limitations:
- Computer agent handles Office well but struggles with complex browser workflows
- No mobile apps
- Small community — actively growing
- Hash-based embeddings are the default (model-based via Ollama available in config)
- Governance layer is implemented but still maturing

---

## Roadmap

<details>
<summary>Click to expand</summary>

### Completed

- **v0.6** — `joule init`, hot reload, skill registry, better errors, OpenAPI spec
- **v0.7** — Real embeddings, long-term memory, adaptive routing, crew templates, streaming RAG
- **v0.8** — Tiered constitution, policy engine, governor agent, trust scoring, reward/punishment, vault, accountability chain, consensus, system-level learning

### Next

- **v0.9** — Distributed task queue, persistent state, circuit breakers, horizontal scaling, RBAC, SSO, compliance mode, multi-tenant isolation
- **v1.0** — Feature freeze, audit logging, published benchmarks, security audit, migration guides, documentation site

</details>

---

## Development

```bash
pnpm install       # install dependencies
pnpm build         # build all 9 packages
pnpm test          # 1140 tests across 91 files
pnpm dev           # watch mode
```

---

## When to Use Something Else

| You want... | Use |
|-------------|-----|
| Personal AI butler on WhatsApp | **OpenClaw** |
| Managed browser agent, zero setup | **OpenAI Operator** |
| Pure web scraping / automation | **Browser-Use** or **Skyvern** |
| Coding agents / repo-level tasks | **OpenHands** |
| Python ecosystem + mature RAG | **LangChain** |
| Maximum reliability, no LLM | **Playwright** |

---

## License

[MIT](LICENSE)
