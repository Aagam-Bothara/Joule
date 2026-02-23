# Contributing to Joule

Thank you for your interest in contributing to Joule, the energy-aware AI agent
runtime. This guide covers everything you need to get started.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Development Setup](#development-setup)
3. [Project Structure](#project-structure)
4. [Coding Standards](#coding-standards)
5. [Adding Tools](#adding-tools)
6. [Adding Channels](#adding-channels)
7. [Pull Request Process](#pull-request-process)
8. [Commit Conventions](#commit-conventions)

---

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 10 (the repo enforces `pnpm@10.4.1` via `packageManager`)
- **Git** for version control

Optional (for specific features):

- **Playwright** for browser automation tools
- **mqtt** npm package for IoT MQTT tools
- Platform-specific SDKs for individual channels (see `docs/channels.md`)

---

## Development Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/<your-fork>/joule.git
cd joule

# 2. Install dependencies
pnpm install

# 3. Build all packages
pnpm build

# 4. Run the test suite
pnpm test:run

# 5. (Optional) Start all packages in watch mode
pnpm dev
```

Other useful scripts defined in the root `package.json`:

| Script          | Description                        |
| --------------- | ---------------------------------- |
| `pnpm build`    | Build every package with tsup      |
| `pnpm test`     | Run vitest in watch mode           |
| `pnpm test:run` | Run vitest once and exit           |
| `pnpm lint`     | Lint all packages with ESLint      |
| `pnpm clean`    | Remove `dist/` from every package  |
| `pnpm dev`      | Watch-build all packages in parallel |

---

## Project Structure

Joule is a pnpm monorepo. All packages live under `packages/`.

| Package     | npm Name          | Description                                                        |
| ----------- | ----------------- | ------------------------------------------------------------------ |
| `shared`    | `@joule/shared`   | Constants, type definitions, Zod schemas, and utility functions. Zero internal dependencies. |
| `core`      | `@joule/core`     | Orchestration engine: task executor, budget manager, model router, planner, session manager, scheduler, and proactive engine. |
| `models`    | `@joule/models`   | Provider adapters for Ollama, Anthropic, OpenAI, and Google. Converts a uniform interface into provider-specific API calls. |
| `tools`     | `@joule/tools`    | Built-in tool implementations (filesystem, shell, HTTP, browser, IoT, memory), MCP client, and plugin loader. |
| `cli`       | `@joule/cli`      | Command-line interface. Entry point that wires together all packages and exposes user-facing commands. |
| `server`    | `@joule/server`   | HTTP API server built on Hono. Provides REST endpoints, SSE streaming, authentication, and rate limiting. |
| `dashboard` | `@joule/dashboard` | React single-page application for monitoring tasks, budgets, and energy usage. |
| `channels`  | `@joule/channels` | Messaging platform integrations for 11 platforms (Slack, Discord, Telegram, and more). |

Dependency flow: `shared` is at the bottom, `cli` is at the top. See
`docs/architecture.md` for the full dependency graph.

---

## Coding Standards

- **ESM only.** Every package uses `"type": "module"` and ESM imports with
  `.js` extensions in source.
- **TypeScript strict mode.** Enable all strict checks. No `any` unless
  absolutely necessary and documented.
- **tsup** for builds. Each package has a `tsup.config.ts` or uses the default
  tsup configuration. Build output goes to `dist/`.
- **vitest** for tests. Place tests in `__tests__/` directories or as
  `*.test.ts` files adjacent to source.
- **Inline styles for the dashboard.** The React dashboard uses inline styles
  rather than CSS files or CSS-in-JS libraries.
- **No default exports.** Use named exports exclusively.
- **Descriptive names.** Prefer clarity over brevity in variable and function
  names.

---

## Adding Tools

Tools follow the `ToolDefinition` pattern defined in `@joule/shared`. Each tool
declares its input and output schemas using Zod.

```typescript
import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';

const inputSchema = z.object({
  query: z.string().describe('The search query'),
  maxResults: z.number().default(10),
});

const outputSchema = z.object({
  results: z.array(z.string()),
});

export const mySearchTool: ToolDefinition = {
  name: 'my_search',
  description: 'Search for documents matching a query',
  inputSchema,
  outputSchema,
  tags: ['search'],
  async execute(input) {
    const parsed = input as z.infer<typeof inputSchema>;
    // ... implementation ...
    return { results: [] };
  },
};
```

Place new built-in tools in `packages/tools/src/builtin/` and re-export them
from `packages/tools/src/index.ts`. Register the tool in
`packages/cli/src/setup.ts`.

---

## Adding Channels

Channels extend `BaseChannel` from `packages/channels/src/base-channel.ts`.
Every channel must implement:

1. `connect()` -- establish a connection to the messaging platform.
2. `disconnect()` -- cleanly shut down the connection.
3. `onMessage(callback)` -- register a handler for incoming messages.
4. `sendResponse(sessionId, message)` -- send a reply to the user.

```typescript
import { BaseChannel } from './base-channel.js';
import type { ChannelMessage, ChannelResponse } from './types.js';

export class MyChannel extends BaseChannel {
  async connect(): Promise<void> { /* ... */ }
  async disconnect(): Promise<void> { /* ... */ }
  onMessage(callback: (msg: ChannelMessage) => void): void { /* ... */ }
  async sendResponse(sessionId: string, response: ChannelResponse): Promise<void> { /* ... */ }
}
```

Add the channel config interface to `packages/channels/src/types.ts`, export
the class from `packages/channels/src/index.ts`, and add the corresponding
configuration section to `ChannelsConfig` in
`packages/shared/src/types/config.ts`.

---

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Implement** your changes following the coding standards above.
3. **Write tests** for new functionality. Run `pnpm test:run` to verify.
4. **Lint** your code with `pnpm lint` and fix any issues.
5. **Build** all packages with `pnpm build` to ensure nothing is broken.
6. **Open a pull request** against `main` with a clear description of the
   changes and the motivation behind them.
7. **Address review feedback** promptly.

---

## Commit Conventions

Use conventional commit prefixes in your commit messages:

| Prefix   | Usage                                      |
| -------- | ------------------------------------------ |
| `feat:`  | A new feature                              |
| `fix:`   | A bug fix                                  |
| `docs:`  | Documentation-only changes                 |
| `test:`  | Adding or updating tests                   |
| `refactor:` | Code changes that neither fix a bug nor add a feature |
| `chore:` | Build process, dependency updates, tooling |

Examples:

```
feat: add Mastodon channel integration
fix: prevent budget overflow on concurrent requests
docs: add configuration reference for IoT tools
```

Keep the first line under 72 characters. Use the commit body for additional
context when needed.
