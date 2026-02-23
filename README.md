# Joule

![CI](https://github.com/Aagam-Bothara/Joule/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)

**Energy-aware AI agent runtime with autonomous desktop control.**

Joule is a TypeScript monorepo that does two things:

1. **AI agent runtime** — run tasks with budget constraints on tokens, cost, energy, and carbon
2. **Computer agent** — give it a natural language task and it controls your desktop (Office apps, browsers, anything)

It prefers small local models (Ollama) and only escalates to cloud LLMs (Anthropic, OpenAI, Google) when needed.

---

## How Is Joule Different?

The AI agent space is crowded. Here's an honest breakdown of where Joule fits and when you should use something else.

### The landscape at a glance

There are 5 categories of tools solving related problems:

| Category | Examples | Best for |
|---|---|---|
| **Personal AI assistants** | OpenClaw | "Message it on WhatsApp, it does stuff" |
| **Hosted computer-use agents** | OpenAI Operator, Anthropic Computer Use, Copilot Studio | Managed agents that drive a browser/desktop for you |
| **Web-agent frameworks** | Browser-Use, Skyvern, LaVague | Building reliable web automation with LLMs |
| **Developer agent platforms** | OpenHands (OpenDevin), CrewAI | Coding agents, multi-agent orchestration |
| **Agent runtimes** | **Joule**, LangChain, AutoGPT | Run arbitrary tasks with tools, budgets, and routing |

Joule sits in the **agent runtime** category but borrows from several others — it has messaging channels (like OpenClaw), desktop control (like Operator), and browser automation (like Browser-Use).

### Joule vs OpenClaw

OpenClaw (100K+ GitHub stars) is the closest comparison — both TypeScript/Node.js, both have messaging channels, voice, and browser control. But they solve different problems:

| | Joule | OpenClaw |
|---|---|---|
| **Core idea** | Budget-constrained agent runtime | Personal AI assistant |
| **Model strategy** | SLM-first — prefers local Ollama, escalates only when needed | Cloud-first — Anthropic/OpenAI required |
| **Budget/cost control** | 7-dimension hard limits (tokens, cost, energy, carbon, latency, tool calls, escalations) | No budget enforcement |
| **Energy/carbon tracking** | Yes — tracks Wh and gCO₂ per task | No |
| **Desktop automation** | COM automation for Office + mouse/keyboard + vision | Shell commands + browser (no Office-specific path) |
| **Output validation** | Built-in critic LLM that scores and retries | No |
| **IoT / smart home** | MQTT + Home Assistant | No |
| **Model providers** | 4 (Ollama, Anthropic, OpenAI, Google) | 2 (Anthropic, OpenAI) |
| **Local-only mode** | Yes — runs fully offline with Ollama | No — needs cloud LLM |
| **Messaging channels** | 11 | 15+ (more platforms, including iMessage, Zalo) |
| **Mobile apps** | No | iOS/Android nodes |
| **Canvas/visual workspace** | No | Yes (A2UI) |
| **Security** | Local-first, your data stays on your machine | Has drawn security scrutiny — broad permissions, credential-theft risk in real-world setups |
| **Community** | Small | 100K+ stars |

**In short:** OpenClaw is a personal assistant that lives in your chat apps — "message it on WhatsApp and it does things." Joule is a runtime focused on efficiency within strict budgets — "run 1000 agent tasks without burning $500."

### Joule vs Hosted Computer-Use Agents

**OpenAI Operator / CUA** — Managed agent with its own browser. Less setup friction than Joule, first-party model integration. But you're locked into OpenAI's ecosystem and can't run locally.

**Anthropic Claude Computer Use** — Developer-facing tool spec for building your own agent loop. Strong safety docs. But you still build/host the loop yourself — Joule provides that loop out of the box with budget enforcement on top.

**Microsoft Copilot Studio** — Enterprise-grade computer use with Windows + web automation. Better governance and compliance story. But it's tied to the Microsoft/Power Platform stack and isn't hacker-friendly.

**Where Joule wins:** Runs offline, tracks energy/carbon, works with any LLM provider, has COM automation for Office (faster than mouse-clicking through Excel). Where they win: less setup, managed infrastructure, enterprise compliance.

### Joule vs Web-Agent Frameworks

**Browser-Use** — Purpose-built for web automation. Cleaner web primitives than Joule's Playwright tools. Pick this if your tasks are purely web-based.

**Skyvern** — AI + computer-vision for RPA-style web workflows (forms, logins, downloads). Better at scaling hundreds of runs via API. Pick this for repetitive portal work.

**LaVague** — "Large Action Model" approach for turning intent into repeatable web automation. Good developer ergonomics. Pick this if you want to build reusable web automations.

**Where Joule wins:** Joule isn't web-only — it controls native desktop apps (Excel, PowerPoint, Word via COM), has IoT/MQTT, voice mode, and 11 messaging channels. These frameworks are better at web specifically, Joule is broader.

### Joule vs Developer Platforms

**OpenHands (formerly OpenDevin)** — Open platform for software-engineering agents. Better at repo-level tasks, multi-agent dev patterns, sandboxing. Pick this for coding agents.

**CrewAI** — Multi-agent orchestration. Better at coordinating multiple agents with different roles. Pick this if you need agents collaborating on complex workflows.

**Where Joule wins:** Budget enforcement (7 dimensions), energy tracking, local-first model routing, native desktop/Office automation. These platforms don't track cost or energy at all.

### What makes Joule unique

Six things no other framework in any category does together:

**1. 7-dimension budget enforcement.** Tokens, cost, energy, carbon, latency, tool calls, escalations. Hard limits, not just logging. The agent stops when the budget runs out.

**2. SLM-first model routing.** Smallest capable model for each step. Local Ollama for simple tasks, cloud LLM only when needed and only if budget allows.

**3. Office automation via COM.** One PowerShell command creates an entire formatted spreadsheet. 10x faster than mouse/keyboard. No other agent framework has a dedicated fast-path for Office apps.

**4. Built-in output validation.** Separate critic LLM scores the result 1-10 and requests fixes. Catches empty cells, missing slides, placeholder data.

**5. Runs fully offline.** With Ollama, zero cloud dependency. Your data never leaves your machine.

**6. Full runtime in one install.** 11 messaging channels, IoT/MQTT, voice, scheduling, browser automation, HTTP API, React dashboard — all built in.

### Full comparison

| | Joule | OpenClaw | Operator | Browser-Use | OpenHands | CrewAI | LangChain |
|---|---|---|---|---|---|---|---|
| Language | TypeScript | TypeScript | Managed | Python | Python | Python | Python |
| Budget enforcement | 7 dimensions | None | Pay-per-use | None | None | None | Token limit |
| Energy/carbon tracking | Yes | No | No | No | No | No | No |
| Local-only mode | Ollama | No | No | Via config | Via config | Via config | Via adapters |
| Desktop/Office control | COM + vision | Shell + browser | Browser only | Browser only | Browser + CLI | No | No |
| Output validation | Critic loop | No | No | No | No | No | No |
| Messaging channels | 11 | 15+ | No | No | No | No | External |
| IoT / smart home | MQTT + HA | No | No | No | No | No | No |
| Voice mode | Built-in | Built-in | No | No | No | No | No |
| Mobile apps | No | iOS/Android | No | No | No | No | No |
| Multi-agent | No | No | No | No | Yes | Yes | Yes |
| API server | Hono | Gateway WS | Managed | No | Web UI | No | LangServe |
| Self-hosted | Yes | Yes | No | Yes | Yes | Yes | Yes |
| Community | Small | 100K+ | N/A | Growing | Growing | Growing | Large |

### When to use Joule vs something else

| You want... | Use |
|---|---|
| A personal AI butler on WhatsApp/Telegram | **OpenClaw** |
| Managed browser agent, zero setup | **OpenAI Operator** |
| Enterprise desktop automation with compliance | **Copilot Studio** |
| Scalable web scraping / form filling | **Skyvern** or **Browser-Use** |
| Coding agents / software engineering | **OpenHands** |
| Multi-agent orchestration | **CrewAI** |
| Budget-controlled tasks with energy tracking | **Joule** |
| Offline/local-first agent runtime | **Joule** |
| Windows Office automation (Excel, PowerPoint, Word) | **Joule** |
| Maximum reliability, no LLM | **Playwright / Selenium** |

### What Joule is NOT good at (yet)

- Computer agent is a working prototype — handles Office tasks well, struggles with complex browser workflows
- No multi-agent orchestration (CrewAI does this better)
- No built-in RAG pipeline (LangChain has more mature retrieval)
- No mobile apps (OpenClaw has iOS/Android)
- Much smaller community than OpenClaw or Python frameworks
- Not as polished for pure web automation as Browser-Use or Skyvern

---

## What It Can Do

### Computer Agent (`joule do`)
Tell Joule what to do in plain English. It sees your screen, thinks, and acts.

```bash
# Create a PowerPoint presentation
joule do "Create a 5-slide presentation about AI and save as AI.pptx on Desktop"

# Create an Excel spreadsheet with live data
joule do "Fetch today's weather for Mumbai and create an Excel spreadsheet with the forecast"

# Any desktop task
joule do "Open Notepad and write a meeting agenda for tomorrow"
```

**How it works:**
1. Takes a screenshot of your screen
2. Sends it to a vision-capable LLM
3. LLM decides what to do (PowerShell COM automation for Office, keyboard/mouse for everything else)
4. Executes the action
5. Screenshots again, evaluates, repeats until done
6. Validates the output quality (catches missing data, incomplete slides, etc.)

### Task Execution (`joule run`)
One-shot task execution with budget enforcement.

```bash
joule run "Summarize the top HN stories" --budget medium
```

### Interactive Chat (`joule chat`)
Streaming chat with session persistence.

```bash
joule chat
```

### API Server (`joule serve`)
REST API with JWT auth, streaming, and energy tracking.

```bash
joule serve  # starts on port 3927
```

---

## Current Status

**Working and tested (597 tests passing):**
- Core runtime — task execution, budget management, model routing, tracing
- 4 model providers — Ollama (local), Anthropic, OpenAI, Google
- 11 messaging channels — Slack, Discord, Telegram, WhatsApp, Signal, Teams, Email, Matrix, IRC, Twilio SMS, Webhook
- Computer agent — screenshot → think → act loop with COM automation
- Validation system — separate LLM call critiques the output and requests fixes
- HTTP fetch — agent can pull live data from APIs before creating documents
- Voice mode — wake word, speech-to-text, text-to-speech
- Scheduling — cron-based recurring tasks
- Browser automation — Playwright (6 tools)
- IoT/MQTT — smart home integration
- Plugin system — npm + MCP protocol
- Persistent memory — episodes, preferences, sessions
- API server + React dashboard

**What we're actively working on (Computer Agent improvements):**
- COM script reliability — scripts can fail silently, needs better error handling
- Validator stability — retry loop can create duplicate files when it re-runs scripts
- Window management — validator sometimes screenshots the wrong window
- Performance — ~100s per PowerPoint task, each screenshot+LLM roundtrip is expensive
- Learning from mistakes — agent doesn't remember past failures across runs

---

## Architecture

```
@joule/cli
├── run       — one-shot task execution
├── chat      — interactive streaming chat
├── do        — autonomous computer agent (screenshot → think → act)
├── serve     — HTTP API server
├── voice     — JARVIS voice mode
├── schedule  — cron task scheduling
├── plugins   — plugin management
├── channels  — messaging platform status
└── ...

@joule/core           — TaskExecutor, BudgetManager, ModelRouter, ComputerAgent, TraceLogger
@joule/models         — Ollama, Anthropic, OpenAI, Google providers (multimodal support)
@joule/tools          — shell_exec, os_automation, http_fetch, browser, MQTT, MCP, plugins
@joule/shared         — types, schemas, budget presets, energy calculations
@joule/server         — Hono REST API, JWT auth, streaming
@joule/channels       — 11 messaging platforms
@joule/dashboard      — React + Vite monitoring UI
```

---

## Quick Start

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
# Minimal — local only
providers:
  ollama:
    baseUrl: http://localhost:11434
    enabled: true
    models:
      slm: qwen2.5:1.5b

# For computer agent (needs vision model)
providers:
  anthropic:
    apiKey: sk-ant-...
    enabled: true
    models:
      default: claude-sonnet-4-20250514
```

Environment variables also work:

| Variable | Description |
|---|---|
| `JOULE_ANTHROPIC_API_KEY` | Anthropic API key |
| `JOULE_OPENAI_API_KEY` | OpenAI API key |
| `JOULE_GOOGLE_API_KEY` | Google AI API key |
| `JOULE_DEFAULT_BUDGET` | Budget preset (low/medium/high/unlimited) |
| `JOULE_SERVER_PORT` | HTTP server port (default: 3927) |

### Run

```bash
# Autonomous desktop agent
pnpm exec tsx packages/cli/bin/joule.ts do "Create an Excel with sales data"

# One-shot task
pnpm exec tsx packages/cli/bin/joule.ts run "Summarize this document"

# Interactive chat
pnpm exec tsx packages/cli/bin/joule.ts chat

# API server
pnpm exec tsx packages/cli/bin/joule.ts serve
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

| Command | Description |
|---|---|
| `joule do <task>` | Autonomous computer agent — controls your desktop |
| `joule run <task>` | One-shot task execution with budget |
| `joule chat` | Interactive chat with session history |
| `joule serve` | Start HTTP API server |
| `joule voice` | JARVIS voice mode |
| `joule config show` | Show current config |
| `joule tools list` | List available tools |
| `joule plugins install/list/search` | Manage plugins |
| `joule schedule add/list/pause/resume` | Manage scheduled tasks |
| `joule channels status/test` | Messaging channel status |
| `joule trace <id>` | View execution trace |

### `joule do` options

| Flag | Default | Description |
|---|---|---|
| `--budget <preset>` | `high` | Budget: low, medium, high, unlimited |
| `--max-iterations <n>` | `30` | Max observe-think-act cycles |
| `--delay <ms>` | `1500` | Screenshot delay between actions |
| `--json` | — | Output result as JSON |

---

## Budget System

Joule tracks 7 dimensions per task:

| Dimension | What it limits |
|---|---|
| Tokens | Total LLM tokens consumed |
| Latency | Wall clock time |
| Tool calls | Number of tool invocations |
| Escalations | Model tier upgrades (SLM → cloud) |
| Cost (USD) | Dollar spend on API calls |
| Energy (Wh) | Estimated compute energy |
| Carbon (gCO₂) | Estimated carbon emissions |

The model router picks the smallest capable model first. If the task is too complex, it escalates — but only within the budget envelope.

---

## Computer Agent — How It Works

The `joule do` command runs a reactive loop:

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

**Available tools:**
- `shell_exec` — PowerShell commands, COM automation (preferred for Office)
- `os_open` — Launch apps/files
- `os_keyboard` — Type, press keys, hotkeys
- `os_mouse` — Click, scroll, move
- `os_window` — Focus, minimize, list windows
- `os_clipboard` — Read/write clipboard
- `os_screenshot` — Capture screen
- `http_fetch` — GET/POST to any URL (for live data)

**Validation system:** After the agent says "done", a separate LLM call reviews the screenshot and scores the output 1-10. If score < 7, it sends fix instructions back to the agent. Max 2 retries before accepting.

---

## Packages

| Package | Description |
|---|---|
| [`@joule/shared`](packages/shared) | Types, Zod schemas, budget presets, energy utilities |
| [`@joule/core`](packages/core) | TaskExecutor, BudgetManager, ModelRouter, ComputerAgent, TraceLogger, Scheduler, SessionManager, VoiceEngine |
| [`@joule/models`](packages/models) | Model providers — Ollama, Anthropic, OpenAI, Google (all with multimodal/vision support) |
| [`@joule/tools`](packages/tools) | Built-in tools, OS automation, browser, MQTT/IoT, MCP, PluginManager |
| [`@joule/cli`](packages/cli) | CLI interface — run, chat, do, serve, voice, schedule, plugins, channels |
| [`@joule/server`](packages/server) | Hono HTTP API, JWT auth, streaming, energy tracking |
| [`@joule/dashboard`](packages/dashboard) | React + Vite monitoring dashboard |
| [`@joule/channels`](packages/channels) | 11 messaging platforms — Slack, Discord, Telegram, WhatsApp, Signal, Teams, Email, Matrix, IRC, Twilio SMS, Webhook |

---

## Development

```bash
pnpm install       # install dependencies
pnpm build         # build all packages
pnpm test          # run tests (597 tests across 53 files)
pnpm dev           # watch mode
```

---

## License

[MIT](LICENSE)
