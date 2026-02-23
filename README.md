# Joule

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![Tests](https://img.shields.io/badge/tests-597%20passing-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)

**Energy-aware AI agent runtime with autonomous desktop control.**

Joule is a TypeScript monorepo that does two things:

1. **AI agent runtime** — run tasks with budget constraints on tokens, cost, energy, and carbon
2. **Computer agent** — give it a natural language task and it controls your desktop (Office apps, browsers, anything)

It prefers small local models (Ollama) and only escalates to cloud LLMs (Anthropic, OpenAI, Google) when needed.

---

## How Is Joule Different?

There are a lot of AI agent frameworks out there — LangChain, AutoGPT, CrewAI, OpenDevin (OpenHands), Claude Code, etc. Here's what Joule does differently and why it exists.

### 1. Energy and cost are first-class constraints, not afterthoughts

Most frameworks let you set a token limit and that's it. Joule tracks **7 dimensions** per task: tokens, latency, tool calls, model escalations, cost (USD), energy (Wh), and carbon (gCO₂). Every LLM call and tool invocation is metered. You set a budget envelope and Joule stays inside it — or stops. This isn't a logging feature. It's a hard constraint that shapes which model gets picked and when the agent stops.

**Why it matters:** Running agents in production costs money and burns energy. If your agent spirals into a retry loop calling GPT-4 50 times, you want it to stop — not just log that it happened.

### 2. Small models first, big models only when needed

Joule's model router picks the **smallest capable model** for each step. A simple text extraction? Local Ollama model. Complex multi-step reasoning? Escalates to Claude or GPT-4 — but only if the budget allows it. Other frameworks default to the biggest model and hope for the best.

**Why it matters:** Most agent tasks don't need a frontier model for every step. Using a 1.5B local model for simple subtasks is faster, cheaper, and doesn't send your data to the cloud.

### 3. Desktop control that actually works for Office apps

Most "computer use" agents (OpenDevin, Anthropic's computer use) control the screen by clicking and typing — like a human would. Joule does that too, but for Office apps (Excel, PowerPoint, Word) it uses **PowerShell COM automation** instead. One shell command creates an entire spreadsheet with formatting. No pixel hunting, no misclicks, no waiting for UI to render.

```
# Other agents: click cell A1, type "Name", tab, type "Score", tab, type "Alice"...  (50+ actions)
# Joule: one shell_exec creates the whole thing in 2 seconds
```

**Why it matters:** Mouse/keyboard automation is slow and fragile. COM automation is 10x faster and doesn't break when a dialog box pops up.

### 4. Built-in validation — the agent checks its own work

After the agent says "done", a **separate LLM call** screenshots the result and scores it as a critic. Empty cells? Missing slides? Placeholder data? The validator catches it and sends fix instructions back. This is built into the loop, not a separate tool.

**Why it matters:** Every agent lies about being "done". Without validation, you get empty spreadsheets and half-finished presentations that the agent confidently says are complete.

### 5. It's a full runtime, not just an agent framework

Joule isn't just a "build your own agent" toolkit. It ships with:
- **11 messaging channels** — Slack, Discord, Telegram, WhatsApp, etc. (not via plugins — built in)
- **IoT/MQTT** — control smart home devices
- **Voice mode** — wake word detection, speech-to-text, text-to-speech
- **Cron scheduling** — recurring tasks with budget awareness
- **Browser automation** — Playwright with 6 tools
- **HTTP API** — deploy as a service with JWT auth
- **React dashboard** — monitor tasks, budgets, energy in real time

Most frameworks give you the agent core and tell you to wire up everything else yourself.

### 6. TypeScript, not Python

LangChain, CrewAI, AutoGPT, OpenDevin — all Python. Joule is 100% TypeScript. If your stack is Node.js, you don't need a Python sidecar to run agents. Same language for your app and your agent.

### Honest comparison

| | Joule | LangChain | AutoGPT | OpenDevin | CrewAI |
|---|---|---|---|---|---|
| Language | TypeScript | Python | Python | Python | Python |
| Budget enforcement | 7 dimensions | Token limit | Token limit | None | None |
| Energy/carbon tracking | Yes | No | No | No | No |
| Local model routing | Built-in (Ollama) | Via adapters | Via plugins | Via adapters | Via adapters |
| Desktop control | COM + mouse/keyboard | No | Via plugins | Browser only | No |
| Output validation | Built-in critic loop | No | No | No | No |
| Messaging channels | 11 built-in | External | No | No | No |
| IoT / smart home | MQTT + Home Assistant | No | No | No | No |
| Voice mode | Built-in | No | No | No | No |
| Production API server | Built-in (Hono) | LangServe | No | Web UI | No |

**What Joule is NOT good at (yet):**
- The computer agent is a working prototype — it handles Office tasks well but struggles with complex visual/browser workflows
- No multi-agent orchestration (CrewAI does this better)
- No built-in RAG pipeline (LangChain has more mature retrieval tools)
- Smaller community and ecosystem than Python frameworks

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
git clone https://github.com/joule-ai/joule.git
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
