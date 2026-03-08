<div align="center">

# Joule

### AI agents with a budget, a constitution, and an off switch.

Production-grade agent runtime with built-in budget enforcement,
governance policies, and safety guardrails.

[Quickstart](#quickstart) · [Why Joule](#why-joule) · [Examples](#examples) · [Docs](#documentation)

![CI](https://github.com/Aagam-Bothara/Joule/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Tests](https://img.shields.io/badge/tests-1140%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)

</div>

---

```typescript
import { Joule } from '@joule/core';

// One line. Auto-detects your API keys. Returns a string.
const answer = await Joule.simple("Summarize the top 3 HN stories today");
```

```typescript
// Production mode: budget cap, governance, full observability.
const joule = new Joule({
  providers: { anthropic: { enabled: true } },
  budget: { maxTokens: 50_000, maxCostUsd: 0.50 },
  governance: { constitution: 'default', requireApproval: ['shell_exec'] },
});

const result = await joule.execute({
  description: "Analyze our Q4 metrics and draft a summary",
  budget: 'medium',
});

console.log(result.result);
console.log(`Cost: $${result.budgetUsed.costUsd} | Tokens: ${result.budgetUsed.tokensUsed}`);
```

> **Other frameworks let you build agents. Joule lets you ship them.**

---

## Why Joule?

| Problem | How Joule solves it |
|---------|-------------------|
| Agents burn through tokens with no limit | **7-dimensional budget enforcement** — token, cost, time, tool-call, energy, carbon, and depth caps per task |
| No guardrails on what agents can do | **Constitutional AI + governance** — tiered safety rules that block or flag dangerous actions before execution |
| Can't see what happened after the fact | **Built-in tracing** — Gantt-chart timeline, per-step token/cost breakdown, exportable to Langfuse/OTLP |
| Vendor lock-in to one model provider | **Automatic routing** — local (Ollama) ↔ cloud (Anthropic/OpenAI/Google) with circuit breaker failover |
| Multi-agent coordination is fragile | **Crew orchestration** — sequential, parallel, hierarchical, and debate strategies with structured output validation |
| Agents run unsupervised with no accountability | **Trust scoring** — agents earn autonomy through clean behavior; violations restrict access automatically |

### How Joule compares

|                        | Joule | LangChain | CrewAI | AutoGen |
|------------------------|:-----:|:---------:|:------:|:-------:|
| Budget enforcement     |  ✅   |    ❌     |   ❌   |   ❌    |
| Constitutional safety  |  ✅   |    ❌     |   ❌   |   ❌    |
| Trust scoring / governance |  ✅   |    ❌     |   ❌   |   ❌    |
| Local-first model routing |  ✅   |    🔶     |   ❌   |   ❌    |
| Built-in dashboard     |  ✅   |    ❌     |   ❌   |   ❌    |
| Trace export (OTLP/Langfuse) |  ✅   |    🔶     |   ❌   |   ❌    |
| Multi-agent crews      |  ✅   |    ✅     |   ✅   |   ✅    |
| Structured outputs     |  ✅   |    ✅     |   ✅   |   ✅    |
| Execution replay + diff |  ✅   |    ❌     |   ❌   |   ❌    |
| Energy/carbon tracking |  ✅   |    ❌     |   ❌   |   ❌    |
| Zero-config quickstart |  ✅   |    ❌     |   🔶   |   ❌    |
| Desktop/Office automation |  ✅   |    ❌     |   ❌   |   ❌    |
| 11 messaging channels  |  ✅   |    ❌     |   ❌   |   ❌    |

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

The model router always picks the smallest model that can handle the current step. It only escalates to a bigger model if the budget allows it.

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
| `joule run <task>` | One-shot task with budget |
| `joule chat` | Interactive chat with session history |
| `joule do <task>` | Computer agent — controls your desktop |
| `joule crew run <name> <task>` | Multi-agent orchestration |
| `joule serve` | HTTP API server with SSE streaming |
| `joule replay <task-id>` | Re-run a task with different params, diff the output |
| `joule doctor` | System diagnostics and health check |
| `joule trace <id>` | Inspect execution trace |
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
- 4 model providers with vision support
- 47 built-in tools
- 11 messaging channels
- SQLite persistence with WAL mode
- React dashboard with trace visualization
- Prometheus metrics + OTLP export

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
