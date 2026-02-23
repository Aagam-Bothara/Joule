# Joule Examples

Runnable examples demonstrating Joule's key features.

## Prerequisites

1. Build Joule from the monorepo root:

```bash
pnpm install
pnpm -r build
```

2. Configure a provider. Either:
   - Start Ollama locally (`ollama serve`)
   - Set `JOULE_ANTHROPIC_API_KEY` environment variable

## Running Examples

All examples use `tsx` for direct TypeScript execution:

```bash
npx tsx examples/quick-start.ts
npx tsx examples/chat-bot.ts
npx tsx examples/scheduled-tasks.ts
npx tsx examples/webhook-integration.ts
```

## Example Overview

| Example | Description |
|---------|-------------|
| `quick-start.ts` | Minimal setup: create Joule, register a tool, submit a task, print the result and energy report |
| `chat-bot.ts` | Interactive readline chat loop with session persistence |
| `scheduled-tasks.ts` | Add cron schedules, list them, demonstrate pause/resume |
| `webhook-integration.ts` | Start an HTTP server that receives webhooks, routes them through Joule, and returns responses |
