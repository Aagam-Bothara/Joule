# Configuration Reference

Joule is configured via a `joule.config.yaml` file in the project root. Every
section is optional; sensible defaults are applied when a key is omitted.

---

## Table of Contents

1. [Providers](#providers)
2. [Budgets](#budgets)
3. [Routing](#routing)
4. [Energy](#energy)
5. [Tools](#tools)
6. [Logging](#logging)
7. [Server](#server)
8. [Auth](#auth)
9. [Channels](#channels)
10. [MCP](#mcp)
11. [Browser](#browser)
12. [Schedule](#schedule)
13. [Voice](#voice)
14. [IoT](#iot)
15. [Proactive](#proactive)
16. [Environment Variables](#environment-variables)

---

## Providers

Configure one or more model providers. At least one provider must be enabled.

```yaml
providers:
  ollama:
    baseUrl: "http://localhost:11434"
    models:
      slm: "llama3.2:3b"
      llm: "llama3.2:3b"        # optional, defaults to slm
    enabled: true

  anthropic:
    apiKey: "sk-ant-..."         # or set JOULE_ANTHROPIC_API_KEY
    models:
      slm: "claude-haiku-3.5"
      llm: "claude-sonnet-4-20250514"
    enabled: true

  openai:
    apiKey: "sk-..."             # or set JOULE_OPENAI_API_KEY
    models:
      slm: "gpt-4o-mini"
      llm: "gpt-4o"
    enabled: true

  google:
    apiKey: "AIza..."            # or set JOULE_GOOGLE_API_KEY
    models:
      slm: "gemini-2.0-flash"
      llm: "gemini-2.5-pro"
    enabled: true
```

| Field      | Type    | Description                                  |
| ---------- | ------- | -------------------------------------------- |
| `baseUrl`  | string  | Ollama API base URL                          |
| `apiKey`   | string  | API key for the provider                     |
| `models.slm` | string | Model used for low-complexity tasks         |
| `models.llm` | string | Model used for high-complexity tasks        |
| `enabled`  | boolean | Whether this provider is active              |

---

## Budgets

Control resource consumption per task. Reference a preset by name or override
individual dimensions.

```yaml
budgets:
  default: "medium"              # low | medium | high | unlimited
  presets:
    low:
      maxTokens: 4000
      maxLatencyMs: 10000
      maxToolCalls: 3
      maxEscalations: 0
      costCeilingUsd: 0.01
      maxEnergyWh: 0.005
      maxCarbonGrams: 0.002
    medium:
      maxTokens: 16000
      maxLatencyMs: 30000
      maxToolCalls: 10
      maxEscalations: 1
      costCeilingUsd: 0.10
      maxEnergyWh: 0.05
      maxCarbonGrams: 0.02
    high:
      maxTokens: 100000
      maxLatencyMs: 120000
      maxToolCalls: 25
      maxEscalations: 3
      costCeilingUsd: 1.00
      maxEnergyWh: 0.5
      maxCarbonGrams: 0.2
    unlimited:
      maxTokens: Infinity
      maxLatencyMs: 600000
      maxToolCalls: 100
      maxEscalations: 10
      costCeilingUsd: 10.00
```

| Dimension        | Unit         | Description                            |
| ---------------- | ------------ | -------------------------------------- |
| `maxTokens`      | tokens       | Total input + output tokens            |
| `maxLatencyMs`   | milliseconds | Wall-clock time limit                  |
| `maxToolCalls`   | count        | Maximum tool invocations               |
| `maxEscalations` | count        | Maximum SLM-to-LLM escalations        |
| `costCeilingUsd` | USD          | Monetary cost ceiling                  |
| `maxEnergyWh`    | Wh           | Energy consumption limit               |
| `maxCarbonGrams` | gCO2         | Carbon emission limit                  |

---

## Routing

Control how tasks are routed between SLM and LLM providers.

```yaml
routing:
  preferLocal: true
  slmConfidenceThreshold: 0.6
  complexityThreshold: 0.7
  providerPriority:
    slm: [ollama, google, openai, anthropic]
    llm: [anthropic, openai, google]
  preferEfficientModels: false
  energyWeight: 0.3
  maxReplanDepth: 2
```

| Field                     | Type     | Default | Description                                    |
| ------------------------- | -------- | ------- | ---------------------------------------------- |
| `preferLocal`             | boolean  | `true`  | Prefer local models (e.g., Ollama) over remote |
| `slmConfidenceThreshold`  | number   | `0.6`   | Minimum SLM confidence before accepting        |
| `complexityThreshold`     | number   | `0.7`   | Score above which LLM is used                  |
| `providerPriority.slm`    | string[] | --      | Ordered list of providers for SLM tasks        |
| `providerPriority.llm`    | string[] | --      | Ordered list of providers for LLM tasks        |
| `preferEfficientModels`   | boolean  | `false` | Factor energy efficiency into routing          |
| `energyWeight`            | number   | `0.3`   | Weight given to energy cost during routing      |
| `maxReplanDepth`          | number   | `2`     | Maximum re-planning attempts on failure        |

---

## Energy

Track energy consumption and carbon emissions per model call.

```yaml
energy:
  enabled: true
  gridCarbonIntensity: 400       # gCO2 per kWh for cloud providers
  localModelCarbonIntensity: 0   # gCO2 per kWh for local hardware
  includeInRouting: false
  energyWeight: 0.3
```

| Field                       | Type    | Default | Description                                 |
| --------------------------- | ------- | ------- | ------------------------------------------- |
| `enabled`                   | boolean | `true`  | Enable energy tracking                      |
| `gridCarbonIntensity`       | number  | `400`   | Cloud grid carbon intensity (gCO2/kWh)      |
| `localModelCarbonIntensity` | number  | `0`     | Local hardware carbon intensity (gCO2/kWh)  |
| `includeInRouting`          | boolean | `false` | Factor energy into routing decisions        |
| `energyWeight`              | number  | `0.3`   | Weight for energy cost in routing (0.0-1.0) |

---

## Tools

Configure built-in tools, plugin directories, and tool restrictions.

```yaml
tools:
  builtinEnabled: true
  pluginDirs:
    - "./plugins"
    - "/usr/local/share/joule/plugins"
  disabledTools:
    - "shell_exec"
```

| Field            | Type     | Default | Description                            |
| ---------------- | -------- | ------- | -------------------------------------- |
| `builtinEnabled` | boolean  | `true`  | Register built-in tools                |
| `pluginDirs`     | string[] | `[]`    | Directories to scan for plugin files   |
| `disabledTools`  | string[] | `[]`    | Tool names to exclude from registration |

---

## Logging

Control log verbosity and trace output destination.

```yaml
logging:
  level: "info"                  # debug | info | warn | error
  traceOutput: "memory"         # memory | file | both
  traceDir: ".joule/traces"
```

| Field         | Type   | Default    | Description                       |
| ------------- | ------ | ---------- | --------------------------------- |
| `level`       | string | `"info"`   | Minimum log level                 |
| `traceOutput` | string | `"memory"` | Where to store execution traces   |
| `traceDir`    | string | --         | Directory for file-based traces   |

---

## Server

Configure the HTTP API server.

```yaml
server:
  port: 3927
  host: "127.0.0.1"
  apiKey: "your-api-key"         # simple API key auth (legacy)
```

| Field    | Type   | Default       | Description                         |
| -------- | ------ | ------------- | ----------------------------------- |
| `port`   | number | `3927`        | Port the server listens on          |
| `host`   | string | `"127.0.0.1"` | Bind address                       |
| `apiKey`  | string | --            | Legacy API key for simple auth     |

---

## Auth

Enable JWT-based authentication with user management.

```yaml
auth:
  enabled: true
  jwtSecret: "change-me-to-a-random-secret"
  tokenExpirySeconds: 86400      # 24 hours
  store: "file"
```

| Field                | Type   | Default  | Description                        |
| -------------------- | ------ | -------- | ---------------------------------- |
| `enabled`            | boolean | `false` | Enable authentication              |
| `jwtSecret`          | string | --       | Secret key for signing JWTs        |
| `tokenExpirySeconds` | number | `86400` | Token lifetime in seconds          |
| `store`              | string | `"file"` | User data storage backend         |

---

## Channels

Configure messaging platform integrations. Each channel is optional. See
`docs/channels.md` for detailed setup instructions per platform.

```yaml
channels:
  slack:
    botToken: "xoxb-..."
    appToken: "xapp-..."
    allowedChannels: ["C01234"]
    budgetPreset: "medium"

  discord:
    botToken: "..."
    allowedGuilds: ["123456"]
    budgetPreset: "medium"

  telegram:
    botToken: "123456:ABC..."
    allowedChats: ["12345"]
    budgetPreset: "medium"

  whatsapp:
    allowedNumbers: ["+1234567890"]
    budgetPreset: "low"

  signal:
    account: "+1234567890"
    budgetPreset: "low"

  teams:
    appId: "..."
    appPassword: "..."
    budgetPreset: "medium"

  email:
    imap: { host: "imap.example.com", user: "bot", pass: "secret" }
    smtp: { host: "smtp.example.com", user: "bot", pass: "secret" }
    pollIntervalMs: 30000
    budgetPreset: "medium"

  matrix:
    homeserverUrl: "https://matrix.org"
    accessToken: "..."
    userId: "@joule:matrix.org"
    budgetPreset: "medium"

  irc:
    server: "irc.libera.chat"
    nick: "joule-bot"
    channels: ["#joule"]
    budgetPreset: "low"

  twilioSms:
    accountSid: "AC..."
    authToken: "..."
    phoneNumber: "+1234567890"
    webhookPort: 3928
    budgetPreset: "low"

  webhook:
    port: 3929
    path: "/hook"
    secret: "whsec_..."
    budgetPreset: "medium"
```

---

## MCP

Connect to Model Context Protocol servers to import external tools.

```yaml
mcp:
  servers:
    filesystem:
      transport: "stdio"
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
      enabled: true

    remote-tools:
      transport: "sse"
      url: "http://localhost:8080/sse"
      enabled: true
```

| Field       | Type     | Description                                |
| ----------- | -------- | ------------------------------------------ |
| `transport` | string   | `"stdio"` or `"sse"`                      |
| `command`   | string   | Command to spawn (stdio transport)         |
| `args`      | string[] | Arguments for the command                  |
| `env`       | object   | Environment variables for the process      |
| `url`       | string   | URL for SSE transport                      |
| `enabled`   | boolean  | Whether this server is active              |

---

## Browser

Configure Playwright-based browser automation tools.

```yaml
browser:
  headless: true
  screenshotDir: ".joule/screenshots"
  idleTimeoutMs: 60000
```

---

## Schedule

Configure the cron-based task scheduler.

```yaml
schedule:
  enabled: true
  scheduleFile: ".joule/schedules.json"
  maxConcurrent: 3
  telemetryEnabled: true
```

---

## Voice

Configure voice interaction (speech-to-text and text-to-speech).

```yaml
voice:
  enabled: true
  wakeWord: "joule"
  sttProvider: "ollama"          # ollama | openai | local
  ttsProvider: "system"          # system | elevenlabs | none
  silenceThresholdMs: 1500
  sampleRate: 16000
```

---

## IoT

Configure IoT integrations for MQTT and Home Assistant.

```yaml
iot:
  mqttBrokerUrl: "mqtt://localhost:1883"
  homeAssistantUrl: "http://homeassistant.local:8123"
  homeAssistantToken: "eyJ..."
```

---

## Proactive

Configure the proactive engine for trigger-based task execution.

```yaml
proactive:
  enabled: true
  tickIntervalMs: 60000
```

---

## Environment Variables

Environment variables override their corresponding config file values.

| Variable                      | Config Equivalent              | Description                    |
| ----------------------------- | ------------------------------ | ------------------------------ |
| `JOULE_ANTHROPIC_API_KEY`     | `providers.anthropic.apiKey`   | Anthropic API key              |
| `JOULE_OPENAI_API_KEY`        | `providers.openai.apiKey`      | OpenAI API key                 |
| `JOULE_GOOGLE_API_KEY`        | `providers.google.apiKey`      | Google API key                 |
| `JOULE_DEFAULT_BUDGET`        | `budgets.default`              | Default budget preset name     |
| `JOULE_LOG_LEVEL`             | `logging.level`                | Log level (debug/info/warn/error) |
| `JOULE_SERVER_PORT`           | `server.port`                  | HTTP server port               |
| `JOULE_API_KEY`               | `server.apiKey`                | Legacy API key for simple auth |
| `JOULE_ENERGY_ENABLED`        | `energy.enabled`               | Enable energy tracking (true/false) |
| `JOULE_GRID_CARBON_INTENSITY` | `energy.gridCarbonIntensity`   | Grid carbon intensity (gCO2/kWh) |
