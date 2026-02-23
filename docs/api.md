# HTTP API Reference

Joule exposes an HTTP API via the `@joule/server` package. The server is built
on [Hono](https://hono.dev/) and listens on `http://127.0.0.1:3927` by default.

Start the server with:

```bash
joule serve
```

---

## Table of Contents

1. [Authentication](#authentication)
2. [Task Endpoints](#task-endpoints)
3. [Tool Endpoints](#tool-endpoints)
4. [Health Endpoint](#health-endpoint)
5. [Auth Endpoints](#auth-endpoints)
6. [User Endpoints](#user-endpoints)
7. [Rate Limiting](#rate-limiting)
8. [Error Responses](#error-responses)

---

## Authentication

Joule supports two authentication modes.

### JWT Authentication (recommended)

When `auth.enabled` is `true` in the config, all task and tool endpoints require
a valid JWT or API key.

Pass the token in the `Authorization` header:

```
Authorization: Bearer <jwt-token>
```

### API Key Authentication

Users can generate API keys via `POST /auth/api-keys`. API keys use the `jk_`
prefix and are passed the same way:

```
Authorization: Bearer jk_your_api_key_here
```

### Legacy Simple Auth

When `auth.enabled` is not set but `server.apiKey` is configured, the server
uses simple bearer token matching on task endpoints only.

---

## Task Endpoints

### POST /tasks

Submit a task for execution. Blocks until the task completes.

**Request body:**

```json
{
  "description": "Summarize the contents of README.md",
  "budget": "medium",
  "context": "optional additional context",
  "tools": ["file_read"]
}
```

| Field         | Type     | Required | Description                        |
| ------------- | -------- | -------- | ---------------------------------- |
| `description` | string   | yes      | The task to execute                |
| `budget`      | string   | no       | Budget preset (default: `"medium"`) |
| `context`     | string   | no       | Additional context for the planner |
| `tools`       | string[] | no       | Restrict to specific tool names    |

**Response:** `201 Created`

Returns the full `TaskResult` object including response text, execution trace,
budget usage, and energy metrics.

### POST /tasks/stream

Submit a task and receive results via Server-Sent Events (SSE).

**Request body:** Same as `POST /tasks`.

**SSE events:**

| Event      | Data                                   | Description                    |
| ---------- | -------------------------------------- | ------------------------------ |
| `progress` | `{ step, total, description }`         | Execution progress update      |
| `chunk`    | `{ text }`                             | Partial response text          |
| `result`   | Full `TaskResult` object               | Final result                   |
| `error`    | `{ error, issues? }`                   | Validation or execution error  |

**Example with curl:**

```bash
curl -N -X POST http://localhost:3927/tasks/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"description": "List files in the current directory"}'
```

### GET /tasks

List all completed tasks.

**Response:** `200 OK`

```json
[
  {
    "id": "task_abc123",
    "taskId": "task_abc123",
    "status": "completed",
    "completedAt": "2025-01-15T10:30:00.000Z",
    "budgetUsed": { "tokens": 1234, "costUsd": 0.02 }
  }
]
```

### GET /tasks/:id

Get the full result for a specific task.

**Response:** `200 OK` with the `TaskResult` object, or `404 Not Found`.

### GET /tasks/:id/trace

Get the execution trace for a specific task.

**Response:** `200 OK` with the trace object, or `404 Not Found`.

---

## Tool Endpoints

### GET /tools

List all registered tools.

**Response:** `200 OK`

```json
[
  {
    "name": "file_read",
    "description": "Read the contents of a file",
    "tags": ["filesystem"]
  }
]
```

---

## Health Endpoint

### GET /health

Health check endpoint.

**Response:** `200 OK`

```json
{
  "status": "ok",
  "uptime": 3600
}
```

---

## Auth Endpoints

These endpoints are only available when `auth.enabled` is `true`.

### POST /auth/login

Authenticate and receive a JWT.

**Request body:**

```json
{
  "username": "alice",
  "password": "secret"
}
```

**Response:** `200 OK`

```json
{
  "token": "eyJhbG...",
  "user": { "id": "usr_abc", "username": "alice", "role": "user" }
}
```

### POST /auth/register

Create a new user account.

**Request body:**

```json
{
  "username": "alice",
  "password": "secret",
  "role": "user"
}
```

**Response:** `201 Created` with the same shape as the login response.

### GET /auth/me

Get the current authenticated user's profile, including API keys and quota.

**Requires:** Authentication.

### POST /auth/api-keys

Generate a new API key for the authenticated user.

**Request body:**

```json
{
  "name": "my-integration"
}
```

**Response:** `201 Created`

```json
{
  "id": "key_abc",
  "key": "jk_full_key_shown_once",
  "name": "my-integration",
  "createdAt": "2025-01-15T10:00:00.000Z"
}
```

The full key is only returned at creation time.

### DELETE /auth/api-keys/:id

Delete an API key.

**Requires:** Authentication. The key must belong to the authenticated user.

**Response:** `200 OK` with `{ "deleted": true }`, or `404 Not Found`.

---

## User Endpoints

Admin-only endpoints. Require authentication with a user that has the `admin` role.

### GET /users

List all registered users.

---

## Rate Limiting

When authentication is enabled, the `/tasks/*` and `/tools/*` endpoints are
rate-limited to **60 requests per minute** per client. Exceeding the limit
returns a `429 Too Many Requests` response.

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "Human-readable error message",
  "issues": []
}
```

| Status Code | Meaning                                    |
| ----------- | ------------------------------------------ |
| `400`       | Invalid request body or parameters         |
| `401`       | Missing or invalid authentication          |
| `403`       | Insufficient permissions (e.g., not admin) |
| `404`       | Resource not found                         |
| `429`       | Rate limit exceeded                        |
| `500`       | Internal server error                      |
