# Joule Examples

Runnable examples demonstrating Joule's key features.

## Prerequisites

1. Build Joule from the monorepo root:

```bash
pnpm install
pnpm build
```

2. Configure a provider — either:
   - Start Ollama locally (`ollama serve`)
   - Set `JOULE_ANTHROPIC_API_KEY`, `JOULE_OPENAI_API_KEY`, or `JOULE_GOOGLE_API_KEY`

## Running Examples

All examples use `tsx` for direct TypeScript execution:

```bash
npx tsx examples/quick-start.ts
```

## Examples

| Example | What it demonstrates |
|---------|---------------------|
| [`quick-start.ts`](quick-start.ts) | Minimal setup — create Joule, register a tool, run a task, see the energy report |
| [`budget-constrained.ts`](budget-constrained.ts) | **7-dimensional budget enforcement** — run a task with strict cost caps, see exactly what was spent |
| [`research-crew.ts`](research-crew.ts) | **Multi-agent orchestration** — 3 agents (researcher, analyst, writer) collaborate on a research task |
| [`guardrails.ts`](guardrails.ts) | **Governance + safety** — constitutional rules block dangerous tools, approval policies gate actions |
| [`chat-bot.ts`](chat-bot.ts) | Interactive readline chat with session persistence |
| [`scheduled-tasks.ts`](scheduled-tasks.ts) | Cron scheduling — add, list, pause, and resume scheduled tasks |
| [`webhook-integration.ts`](webhook-integration.ts) | HTTP webhook server that routes incoming requests through Joule |

## Start Here

If you're new to Joule, try these in order:

1. **`quick-start.ts`** — understand the basic flow
2. **`budget-constrained.ts`** — see how budget enforcement works
3. **`guardrails.ts`** — see how governance blocks dangerous actions
4. **`research-crew.ts`** — see multi-agent collaboration
