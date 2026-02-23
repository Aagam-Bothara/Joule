# @joule/server

HTTP API server for Joule, built on [Hono](https://hono.dev/). Provides REST
endpoints for task execution, SSE streaming, tool listing, authentication,
user management, and rate limiting.

## Installation

```bash
pnpm add @joule/server
```

## Key Exports

- `createApp(joule)` -- create a configured Hono application
- `startServer(joule)` -- start the HTTP server on the configured host and port
- `UserStore` -- file-backed user storage for authentication
- `signJwt(payload, secret, expiry)` -- sign a JWT token
- `verifyJwt(token, secret)` -- verify and decode a JWT token

## HTTP Endpoints

The server registers the following routes:

### Task Endpoints

| Method | Path              | Description                        |
| ------ | ----------------- | ---------------------------------- |
| POST   | `/tasks`          | Submit a task (blocking)           |
| POST   | `/tasks/stream`   | Submit a task with SSE streaming   |
| GET    | `/tasks`          | List all completed tasks           |
| GET    | `/tasks/:id`      | Get a specific task result         |
| GET    | `/tasks/:id/trace`| Get the execution trace            |

### Tool and Health Endpoints

| Method | Path      | Description              |
| ------ | --------- | ------------------------ |
| GET    | `/tools`  | List registered tools    |
| GET    | `/health` | Health check             |

### Auth Endpoints (when auth is enabled)

| Method | Path               | Description              |
| ------ | ------------------ | ------------------------ |
| POST   | `/auth/login`      | Authenticate             |
| POST   | `/auth/register`   | Create a user account    |
| GET    | `/auth/me`         | Get current user profile |
| POST   | `/auth/api-keys`   | Generate an API key      |
| DELETE | `/auth/api-keys/:id` | Delete an API key      |
| GET    | `/users`           | List users (admin only)  |

## Usage

```typescript
import { Joule } from '@joule/core';
import { createApp, startServer } from '@joule/server';

const joule = new Joule();
// ... register providers and tools ...

// Option 1: start the server directly
await startServer(joule);

// Option 2: get the Hono app for custom middleware
const app = await createApp(joule);
// app is a standard Hono instance you can extend
```

See `docs/api.md` for the full HTTP API reference.
