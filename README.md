# Joule

![CI](https://github.com/Aagam-Bothara/Joule/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)

**An AI agent runtime that actually cares about how much you spend.**

Joule lets you run AI agents with hard limits on tokens, cost, energy, and carbon. It coordinates multi-agent crews, controls your desktop via COM automation, and prefers cheap local models (Ollama) over expensive cloud calls — only escalating when the task genuinely needs it.

```bash
# Tell it what to do in plain English
joule do "Create a 5-slide presentation about renewable energy and save it to Desktop"

# Or run a quick task with a budget cap
joule run "Summarize the top HN stories" --budget medium

# Or spin up a crew of agents
joule crew run research-team "Analyze the competitive landscape for our product"
```

---

## Why Joule?

The AI agent space is crowded. Here's where Joule fits — and when you should honestly pick something else.

### The short version

There are a bunch of tools in this space. They mostly fall into 5 buckets:

| Category | Examples | Best for |
|---|---|---|
| **Personal AI assistants** | OpenClaw | "Message it on WhatsApp, it does stuff" |
| **Hosted computer-use agents** | OpenAI Operator, Anthropic Computer Use, Copilot Studio | Managed agents that drive a browser/desktop for you |
| **Web-agent frameworks** | Browser-Use, Skyvern, LaVague | Reliable web automation with LLMs |
| **Developer agent platforms** | OpenHands (OpenDevin), CrewAI | Coding agents, multi-agent workflows |
| **Agent runtimes** | **Joule**, LangChain, AutoGPT | Run arbitrary tasks with tools, budgets, and routing |

Joule is an agent runtime, but it borrows ideas from the others — messaging channels (like OpenClaw), desktop control (like Operator), browser automation (like Browser-Use), and multi-agent orchestration (like CrewAI).

### Joule vs OpenClaw

OpenClaw (100K+ GitHub stars) is the closest comparison. Both are TypeScript, both have messaging channels, voice, and browser control. But they solve different problems:

| | Joule | OpenClaw |
|---|---|---|
| **Philosophy** | "Run 1000 agent tasks without burning $500" | "Message it on WhatsApp, it does things" |
| **Model strategy** | Local-first — runs Ollama, only escalates to cloud when needed | Cloud-first — needs Anthropic/OpenAI |
| **Budget control** | 7-dimension hard limits (tokens, cost, energy, carbon, latency, tool calls, escalations) | None |
| **Energy tracking** | Tracks Wh and gCO₂ per task | No |
| **Desktop automation** | COM for Office + mouse/keyboard + vision | Shell + browser (no Office-specific path) |
| **Multi-agent** | 4 strategies with per-agent budgets | No |
| **Approval workflows** | 3 modes — automatic, manual, hybrid | No |
| **RAG** | Built-in document chunking + vector search | No |
| **Response caching** | SQLite-backed with TTL | No |
| **Observability** | Structured logs, Prometheus, OTLP spans | No |
| **Providers** | 4 (Ollama, Anthropic, OpenAI, Google) | 2 (Anthropic, OpenAI) |
| **Offline mode** | Fully offline with Ollama | No |
| **Channels** | 11 | 15+ (including iMessage, Zalo) |
| **Mobile apps** | No | iOS/Android |
| **Community** | Small | 100K+ stars |

### Joule vs the rest

**OpenAI Operator / Copilot Studio** — Less setup, managed infrastructure, better compliance story. But vendor-locked and can't run locally. Joule runs offline, tracks energy, and has COM automation for Office (way faster than clicking through Excel with a mouse).

**Browser-Use / Skyvern / LaVague** — Better at pure web automation. If your tasks are web-only, pick one of those. Joule is broader — desktop apps, IoT, voice, 11 messaging channels.

**OpenHands** — Better for coding agents and repo-level tasks. Pick this for software engineering workflows.

**CrewAI** — Joule now has 4 orchestration strategies (sequential, parallel, hierarchical, debate) with full budget enforcement per agent. CrewAI doesn't do budgets. If you need agents that stop when money runs out, that's Joule.

**LangChain** — More mature RAG ecosystem, bigger community, Python. Joule is TypeScript-native and lighter weight. LangChain doesn't track energy or carbon.

### What makes Joule different

Most of these exist individually in other tools. Nobody else does all of them together:

- **Budget enforcement that actually stops the agent.** 7 dimensions. Hard limits, not just logging.
- **Local-first model routing.** Picks the smallest model that can handle the step. Cloud LLM only when necessary.
- **Multi-agent crews with cost controls.** 4 strategies, all budget-constrained. Your agent team can't silently rack up a $200 bill.
- **COM automation for Office.** One PowerShell command creates a formatted spreadsheet. Way faster than screenshotting and clicking.
- **Approval workflows.** Configure which tools need human sign-off before running. Approve by tool name, risk level, cost threshold, or agent handoff.
- **Output validation.** A separate critic LLM scores the result and sends it back for fixes if it's not good enough.
- **Fully offline.** Ollama only. Your data never leaves your machine.
- **Observability out of the box.** Prometheus metrics, structured JSON logs, OpenTelemetry spans. Plug into Grafana or Datadog without writing glue code.
- **Everything in one install.** Channels, voice, scheduling, browser, IoT, RAG, caching, skills, dashboard — no plugin circus.

### When to use something else

| You want... | Use |
|---|---|
| Personal AI butler on WhatsApp/Telegram | **OpenClaw** |
| Managed browser agent, zero setup | **OpenAI Operator** |
| Enterprise desktop automation with compliance | **Copilot Studio** |
| Scalable web scraping / form filling | **Skyvern** or **Browser-Use** |
| Coding agents / software engineering | **OpenHands** |
| Maximum reliability, no LLM | **Playwright / Selenium** |

### Honest limitations

We're not going to pretend Joule does everything well:

- The computer agent handles Office tasks well but still struggles with complex browser workflows. It's a working prototype, not production-grade yet.
- No mobile apps. OpenClaw has iOS/Android, we don't.
- Tiny community compared to OpenClaw or the Python ecosystem.
- Not as polished for pure web automation as Browser-Use or Skyvern.
- RAG uses hash-based embeddings. They're fast and free, but they're not transformer-quality. We're working on optional model-based embeddings.
- Skill marketplace is local-only for now — no hosted registry.

### Full comparison table

For the people who want every detail side by side:

| | Joule | OpenClaw | Operator | Browser-Use | OpenHands | CrewAI | LangChain |
|---|---|---|---|---|---|---|---|
| Language | TypeScript | TypeScript | Managed | Python | Python | Python | Python |
| Budget enforcement | 7 dimensions | None | Pay-per-use | None | None | None | Token limit |
| Energy/carbon | Yes | No | No | No | No | No | No |
| Local-only | Ollama | No | No | Via config | Via config | Via config | Via adapters |
| Desktop/Office | COM + vision | Shell + browser | Browser | Browser | Browser + CLI | No | No |
| Validation | Critic loop | No | No | No | No | No | No |
| Channels | 11 | 15+ | No | No | No | No | External |
| IoT | MQTT + HA | No | No | No | No | No | No |
| Voice | Built-in | Built-in | No | No | No | No | No |
| Mobile | No | iOS/Android | No | No | No | No | No |
| Multi-agent | 4 strategies | No | No | No | Yes | Yes | Yes |
| HITL approvals | 3 modes | No | No | No | No | No | No |
| RAG | Built-in | No | No | No | No | No | Yes |
| Response cache | SQLite | No | No | No | No | No | No |
| Observability | Prometheus + OTLP | No | Managed | No | Built-in | No | LangSmith |
| Rate limiting | Tiered + adaptive | No | Managed | No | No | No | No |
| API server | Hono | Gateway WS | Managed | No | Web UI | No | LangServe |
| Self-hosted | Yes | Yes | No | Yes | Yes | Yes | Yes |
| Community | Small | 100K+ | N/A | Growing | Growing | Growing | Large |

---

## What It Can Do

### Computer Agent (`joule do`)

Tell Joule what to do in plain English. It screenshots your screen, sends it to a vision LLM, decides what to do, acts, and repeats until done.

```bash
joule do "Create a 5-slide presentation about AI and save as AI.pptx on Desktop"
joule do "Fetch today's weather for Mumbai and create an Excel spreadsheet with the forecast"
joule do "Open Notepad and write a meeting agenda for tomorrow"
```

Under the hood:

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ OBSERVE  │────→│  THINK   │────→│   ACT    │────→│ VALIDATE │
│screenshot│     │ LLM with │     │ execute  │     │ critic   │
│ of screen│     │  vision  │     │ tools    │     │ LLM call │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     ↑                                                   │
     └───────────────────────────────────────────────────┘
                    (loop until done or budget exhausted)
```

It prefers COM automation for Office (fast) and falls back to mouse/keyboard for everything else. After the agent says "done," a separate critic LLM reviews the output and sends it back for fixes if the quality is below threshold.

### Multi-Agent Crews (`joule crew`)

Set up teams of agents with different roles and orchestrate them:

```bash
joule crew run my-crew "Analyze competitor landscape"
joule crew list
```

Four strategies depending on the workflow:
- **Sequential** — agents run in order, each one builds on the previous result
- **Parallel** — everyone runs at once, results get merged
- **Hierarchical** — a manager agent delegates subtasks to worker agents
- **Debate** — agents argue with each other, best response wins

Every agent in the crew gets its own budget slice, so the whole thing stays within cost limits.

### Task Execution (`joule run`)

One-shot tasks with a budget cap:

```bash
joule run "Summarize the top HN stories" --budget medium
```

### Interactive Chat (`joule chat`)

Streaming chat with session persistence:

```bash
joule chat
```

### API Server (`joule serve`)

REST API with JWT auth, SSE streaming, and energy tracking:

```bash
joule serve  # starts on http://localhost:3927
```

### System Diagnostics (`joule doctor`)

Checks that everything is wired up correctly:

```bash
joule doctor
# [PASS] Database connection (WAL mode, 4.2 MB)
# [PASS] Anthropic provider (claude-sonnet)
# [WARN] OpenAI provider (no API key)
# [PASS] Tool registry (47 tools)
# ...
```

---

## Where Things Stand

**930 tests passing across 74 files.** Here's what's working:

The core runtime handles task execution, budget management across 7 dimensions, and model routing across 4 providers (Ollama, Anthropic, OpenAI, Google). Multi-agent orchestration supports 4 strategies with per-agent budget allocation.

On the production side, we've got structured JSON logging, a Prometheus metrics endpoint at `/metrics`, OpenTelemetry-compatible span export, tiered rate limiting (role-based, per-endpoint, cost-based, adaptive), and `joule doctor` for system diagnostics.

The human-in-the-loop system supports 3 approval modes with configurable policies — you can require sign-off for specific tools, above certain cost thresholds, or on agent handoffs. Response caching (SQLite-backed, SHA-256 keyed) saves money on repeated queries. The RAG pipeline handles document ingestion with 3 chunking strategies and searches via vector index or TF-IDF.

The computer agent does the screenshot-think-act loop with COM automation for Office apps and a 5-layer screenshot mechanism to keep token usage down. A critic LLM validates output quality.

Platform features: 11 messaging channels, voice mode, cron scheduling, Playwright browser automation, MQTT/IoT, npm + MCP plugins, a skill marketplace, Hono API server, React dashboard, and SQLite persistence with WAL mode.

**What we're actively working on:**
- COM scripts sometimes fail silently — needs better error propagation
- The validator retry loop occasionally creates duplicate files
- Screenshot+LLM roundtrips are expensive — optimizing token usage
- Hash-based embeddings work but aren't as precise as transformer-based ones — adding optional model-based embeddings

---

## Architecture

```
@joule/cli
├── run       — one-shot task execution
├── chat      — interactive streaming chat
├── do        — computer agent (screenshot → think → act)
├── crew      — multi-agent orchestration
├── serve     — HTTP API server
├── voice     — voice mode (wake word + STT/TTS)
├── doctor    — system diagnostics
├── skills    — skill marketplace
├── schedule  — cron scheduling
├── plugins   — plugin management
├── channels  — messaging platforms
└── ...

@joule/core     — engine, executors, budget, model routing, crews, approval,
                  memory, RAG, logging, metrics, shutdown, tracing
@joule/models   — Ollama, Anthropic, OpenAI, Google (all with vision support)
@joule/tools    — shell, OS automation, browser, MQTT, MCP, plugins, skills
@joule/store    — SQLite (WAL), migrations, vector index, response cache
@joule/shared   — types, schemas, budget presets, energy math
@joule/server   — Hono REST API, JWT auth, streaming, Prometheus, rate limiting
@joule/channels — Slack, Discord, Telegram, WhatsApp, Signal, Teams, Email,
                  Matrix, IRC, Twilio SMS, Webhook
@joule/dashboard — React + Vite monitoring UI
```

---

## Getting Started

### Prerequisites
- Node.js >= 22
- pnpm >= 10
- Ollama running locally (recommended) or a cloud API key

### Install

```bash
git clone https://github.com/Aagam-Bothara/Joule.git
cd joule
pnpm install
pnpm build
```

### Configure

Create `joule.config.yaml` in the project root:

```yaml
# Local only — no cloud needed
providers:
  ollama:
    baseUrl: http://localhost:11434
    enabled: true
    models:
      slm: qwen2.5:1.5b

# For computer agent (needs a vision model)
providers:
  anthropic:
    apiKey: sk-ant-...
    enabled: true
    models:
      default: claude-sonnet-4-20250514
```

Or use environment variables:

| Variable | What it does |
|---|---|
| `JOULE_ANTHROPIC_API_KEY` | Anthropic API key |
| `JOULE_OPENAI_API_KEY` | OpenAI API key |
| `JOULE_GOOGLE_API_KEY` | Google AI API key |
| `JOULE_DEFAULT_BUDGET` | Budget preset (low/medium/high/unlimited) |
| `JOULE_SERVER_PORT` | HTTP server port (default: 3927) |

### Run

```bash
# Desktop agent
pnpm exec tsx packages/cli/bin/joule.ts do "Create an Excel with sales data"

# One-shot task
pnpm exec tsx packages/cli/bin/joule.ts run "Summarize this document"

# Chat
pnpm exec tsx packages/cli/bin/joule.ts chat

# API server
pnpm exec tsx packages/cli/bin/joule.ts serve

# Diagnostics
pnpm exec tsx packages/cli/bin/joule.ts doctor
```

### Docker

```bash
docker build -t joule .
docker run -p 3927:3927 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  joule
```

---

## CLI Reference

| Command | What it does |
|---|---|
| `joule do <task>` | Computer agent — controls your desktop |
| `joule run <task>` | One-shot task with budget |
| `joule chat` | Interactive chat with history |
| `joule crew run/list` | Multi-agent orchestration |
| `joule serve` | HTTP API server |
| `joule voice` | Voice mode |
| `joule doctor` | System health check |
| `joule skills list/install/search/create` | Skill marketplace |
| `joule config show` | Show config |
| `joule tools list` | List available tools |
| `joule plugins install/list/search` | Plugin management |
| `joule schedule add/list/pause/resume` | Cron scheduling |
| `joule channels status/test` | Messaging channel status |
| `joule trace <id>` | View execution trace |
| `joule auth login/register` | Auth (when enabled) |

### `joule do` options

| Flag | Default | Description |
|---|---|---|
| `--budget <preset>` | `high` | Budget: low, medium, high, unlimited |
| `--max-iterations <n>` | `30` | Max observe-think-act cycles |
| `--delay <ms>` | `1500` | Delay between screenshots |
| `--json` | — | JSON output |

---

## Budget System

Every task gets tracked across 7 dimensions. When any limit is hit, the agent stops — no "oops I spent $50" surprises.

| Dimension | What it limits |
|---|---|
| Tokens | Total LLM tokens consumed |
| Latency | Wall clock time |
| Tool calls | Number of tool invocations |
| Escalations | Model tier upgrades (local → cloud) |
| Cost (USD) | Dollar spend on API calls |
| Energy (Wh) | Estimated compute energy |
| Carbon (gCO₂) | Estimated carbon emissions |

The model router always picks the smallest model that can handle the current step. It only escalates to a bigger (more expensive) model if the small one can't do the job — and only if the budget allows it.

---

## Packages

| Package | What's in it |
|---|---|
| [`@joule/shared`](packages/shared) | Types, Zod schemas, budget presets, energy math |
| [`@joule/core`](packages/core) | Engine, executors, budget, routing, crews, approval, memory, RAG, logging, metrics, cache, shutdown |
| [`@joule/models`](packages/models) | Ollama, Anthropic, OpenAI, Google — all with vision support |
| [`@joule/tools`](packages/tools) | Shell, OS automation, browser, MQTT, MCP, plugins, skill registry |
| [`@joule/store`](packages/store) | SQLite persistence — WAL mode, migrations, vector index, response cache, rate limits |
| [`@joule/cli`](packages/cli) | Everything under the `joule` command |
| [`@joule/server`](packages/server) | Hono API, JWT auth, streaming, Prometheus metrics, rate limiting |
| [`@joule/dashboard`](packages/dashboard) | React + Vite monitoring dashboard |
| [`@joule/channels`](packages/channels) | 11 messaging platforms |

---

## Development

```bash
pnpm install       # install deps
pnpm build         # build all 9 packages
pnpm test          # 930 tests across 74 files
pnpm dev           # watch mode
```

---

## Roadmap

This is roughly where we're headed. Priorities might shift based on what people actually need.

### v0.6 — Making it nicer to use
- [ ] `joule init` — interactive project scaffolding with config generation
- [ ] Hot reload for config changes (no restart)
- [ ] Hosted skill registry — install skills from npm or GitHub
- [ ] Better error messages — tell people what went wrong *and how to fix it*
- [ ] OpenAPI spec generation from tool schemas

### v0.7 — Making it smarter
- [ ] Real embeddings — optional integration with local embedding models like `nomic-embed-text`
- [ ] Long-term memory — agent remembers what worked and what didn't across runs
- [ ] Adaptive routing — learn which models handle which tasks best over time
- [ ] Crew templates — pre-built agent teams for common jobs (code review, research, content)
- [ ] Streaming RAG — ingest documents as they change, not just at startup

### v0.8 — Making it scale
- [ ] Distributed task queue (Redis/BullMQ) for multi-worker setups
- [ ] Persistent task state — pick up where you left off after a crash
- [ ] Approval requests via Slack/Teams/email (not just in-process callbacks)
- [ ] Circuit breakers — automatic failover when a provider's API goes down
- [ ] Horizontal scaling — stateless server with shared storage (Litestream or Postgres)

### v0.9 — Enterprise stuff
- [ ] Proper RBAC beyond just admin/user
- [ ] Audit logging — immutable record of every tool call, approval, and data access
- [ ] SSO (SAML/OIDC)
- [ ] Compliance mode — data retention policies, PII redaction, geo constraints
- [ ] Multi-tenant isolation — separate budgets, configs, and data per tenant

### v1.0 — Ship it
- [ ] Feature freeze — bugs and hardening only
- [ ] Published benchmarks (latency, throughput, cost per task)
- [ ] Third-party security audit
- [ ] Migration guides from LangChain, CrewAI, and OpenClaw
- [ ] Proper documentation site

---

## License

[MIT](LICENSE)
