# @joule/cli

Command-line interface for Joule, the energy-aware AI agent runtime. Provides
commands for running tasks, interactive chat, serving the HTTP API, managing
schedules, and more.

## Installation

```bash
pnpm add -g @joule/cli
```

Or run from the monorepo:

```bash
pnpm build
node packages/cli/dist/bin/joule.js
```

## Commands

| Command            | Description                                         |
| ------------------ | --------------------------------------------------- |
| `joule run`        | Execute a one-shot task from a description           |
| `joule chat`       | Start an interactive chat session                    |
| `joule serve`      | Start the HTTP API server                            |
| `joule schedule`   | Manage scheduled tasks (cron-based)                  |
| `joule voice`      | Start voice interaction mode                         |
| `joule channels`   | Start messaging channel integrations                 |
| `joule config`     | View or edit the configuration                       |
| `joule tools`      | List registered tools                                |
| `joule trace`      | View execution traces for completed tasks            |

## Key Exports

- `runCommand` -- handler for `joule run`
- `chatCommand` -- handler for `joule chat`
- `serveCommand` -- handler for `joule serve`
- `configCommand` -- handler for `joule config`
- `toolsCommand` -- handler for `joule tools`
- `traceCommand` -- handler for `joule trace`

## Usage

```bash
# Run a task with the default budget
joule run "Summarize the contents of package.json"

# Run with a specific budget
joule run --budget high "Refactor the auth module"

# Start an interactive chat session
joule chat

# Start the HTTP API server
joule serve

# Start the server with channel integrations
joule channels --config joule.config.yaml
```

## Configuration

The CLI reads configuration from `joule.config.yaml` in the current directory.
See `docs/configuration.md` for the full reference.
