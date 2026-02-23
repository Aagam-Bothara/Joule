# Channel Setup Guide

Joule supports 11 messaging platforms through its channel system. Each channel
runs as a persistent connection that forwards user messages to the core engine
and returns results.

This guide covers prerequisites, configuration, and setup for each channel.

---

## Table of Contents

1. [Slack](#slack)
2. [Discord](#discord)
3. [Telegram](#telegram)
4. [WhatsApp](#whatsapp)
5. [Signal](#signal)
6. [Teams](#teams)
7. [Email](#email)
8. [Matrix](#matrix)
9. [IRC](#irc)
10. [Twilio SMS](#twilio-sms)
11. [Webhook](#webhook)

---

## Slack

Connect Joule to a Slack workspace using the Bolt framework.

### Prerequisites

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.
2. Enable **Socket Mode** and generate an **App-Level Token** (`xapp-...`) with
   the `connections:write` scope.
3. Under **OAuth & Permissions**, add the bot scopes: `chat:write`,
   `app_mentions:read`, `channels:history`, `im:history`.
4. Install the app to your workspace and copy the **Bot Token** (`xoxb-...`).

### Configuration

```yaml
channels:
  slack:
    botToken: "xoxb-your-bot-token"
    appToken: "xapp-your-app-token"
    signingSecret: "abc123"          # optional
    allowedChannels: ["C01234ABCDE"] # optional, restrict to specific channels
    budgetPreset: "medium"           # optional, default budget per message
```

---

## Discord

Connect Joule to a Discord server using discord.js.

### Prerequisites

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
   and create a new application.
2. Navigate to **Bot**, create a bot, and copy the **Bot Token**.
3. Enable the **Message Content Intent** under Privileged Gateway Intents.
4. Use the OAuth2 URL generator to invite the bot with `Send Messages` and
   `Read Message History` permissions.

### Configuration

```yaml
channels:
  discord:
    botToken: "your-discord-bot-token"
    allowedGuilds: ["123456789"]       # optional, restrict to specific servers
    allowedChannels: ["987654321"]      # optional, restrict to specific channels
    budgetPreset: "medium"
```

---

## Telegram

Connect Joule to Telegram using the Telegraf library.

### Prerequisites

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to create a bot.
3. Copy the **Bot Token** provided by BotFather.

### Configuration

```yaml
channels:
  telegram:
    botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
    allowedChats: ["12345678"]   # optional, restrict to specific chat IDs
    budgetPreset: "medium"
```

---

## WhatsApp

Connect Joule to WhatsApp using the whatsapp-web.js library.

### Prerequisites

1. Install the peer dependency: `pnpm add whatsapp-web.js`
2. A phone with WhatsApp installed for QR code authentication.
3. On first connection, Joule prints a QR code to the terminal. Scan it with
   WhatsApp on your phone (Settings > Linked Devices > Link a Device).

### Configuration

```yaml
channels:
  whatsapp:
    allowedNumbers: ["+1234567890"]  # optional, restrict to specific numbers
    budgetPreset: "low"
    sessionDataPath: ".joule/whatsapp-session"  # optional, persist session
```

Note: WhatsApp Web sessions expire periodically. You may need to re-scan the
QR code if the session is invalidated.

---

## Signal

Connect Joule to Signal using signal-cli.

### Prerequisites

1. Install [signal-cli](https://github.com/AsamK/signal-cli) on your system.
2. Register or link a phone number with signal-cli:
   ```bash
   signal-cli -u +1234567890 register
   signal-cli -u +1234567890 verify CODE
   ```
3. Ensure signal-cli is available in your PATH, or specify its path in config.

### Configuration

```yaml
channels:
  signal:
    account: "+1234567890"
    signalCliPath: "/usr/local/bin/signal-cli"  # optional
    allowedNumbers: ["+9876543210"]             # optional
    allowGroups: false                           # optional, allow group messages
    budgetPreset: "low"
```

---

## Teams

Connect Joule to Microsoft Teams using the Bot Framework.

### Prerequisites

1. Go to the [Azure Portal](https://portal.azure.com) and register a new
   Bot Channel Registration (or Azure Bot resource).
2. Note the **App ID** and generate an **App Password** (client secret).
3. Configure the messaging endpoint to point to your Joule server.

### Configuration

```yaml
channels:
  teams:
    appId: "your-azure-app-id"
    appPassword: "your-azure-app-password"
    port: 3978                        # optional, Bot Framework listener port
    allowedTenants: ["tenant-id"]     # optional, restrict to specific tenants
    budgetPreset: "medium"
```

Install the peer dependency: `pnpm add botbuilder`

---

## Email

Connect Joule to an email account via IMAP (receiving) and SMTP (sending).

### Prerequisites

1. An email account with IMAP and SMTP access enabled.
2. For Gmail, enable "Less secure app access" or use an App Password.
3. Install the peer dependencies: `pnpm add imap nodemailer`

### Configuration

```yaml
channels:
  email:
    imap:
      host: "imap.gmail.com"
      port: 993                       # optional, default 993
      user: "joule-bot@gmail.com"
      pass: "your-app-password"
      tls: true                       # optional, default true
    smtp:
      host: "smtp.gmail.com"
      port: 587                       # optional, default 587
      user: "joule-bot@gmail.com"
      pass: "your-app-password"
      secure: false                   # optional, default false
    allowedSenders:                    # optional, restrict who can email the bot
      - "alice@example.com"
    pollIntervalMs: 30000             # optional, how often to check for mail
    budgetPreset: "medium"
```

---

## Matrix

Connect Joule to a Matrix homeserver.

### Prerequisites

1. Create a Matrix account for the bot on your homeserver (or use matrix.org).
2. Log in and obtain an **Access Token**. You can retrieve it from Element
   under Settings > Help & About > Access Token, or use the
   `/_matrix/client/r0/login` API.
3. Note the bot's full **User ID** (e.g., `@joule:matrix.org`).
4. Install the peer dependency: `pnpm add matrix-js-sdk`

### Configuration

```yaml
channels:
  matrix:
    homeserverUrl: "https://matrix.org"
    accessToken: "syt_your_access_token"
    userId: "@joule:matrix.org"
    allowedRooms: ["!roomid:matrix.org"]  # optional
    budgetPreset: "medium"
```

---

## IRC

Connect Joule to an IRC network.

### Prerequisites

1. Choose an IRC network (e.g., Libera.Chat, OFTC).
2. Optionally register a nickname with NickServ.
3. Install the peer dependency: `pnpm add irc-framework`

### Configuration

```yaml
channels:
  irc:
    server: "irc.libera.chat"
    port: 6697                        # optional, default 6697
    nick: "joule-bot"
    channels: ["#joule", "#ai"]       # channels to join
    tls: true                         # optional, default true
    requireMention: true              # optional, only respond when mentioned
    budgetPreset: "low"
```

---

## Twilio SMS

Connect Joule to SMS via the Twilio API.

### Prerequisites

1. Create a [Twilio](https://www.twilio.com/) account.
2. Purchase a phone number with SMS capability.
3. Copy your **Account SID** and **Auth Token** from the Twilio console.
4. Configure the SMS webhook URL in Twilio to point to your Joule server
   (e.g., `http://your-server:3928/sms`).
5. Install the peer dependency: `pnpm add twilio`

### Configuration

```yaml
channels:
  twilioSms:
    accountSid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    authToken: "your-auth-token"
    phoneNumber: "+1234567890"
    webhookPort: 3928                 # optional, port for incoming SMS webhook
    allowedNumbers: ["+9876543210"]   # optional
    budgetPreset: "low"
```

---

## Webhook

A generic HTTP webhook channel for custom integrations.

### Prerequisites

No external accounts needed. Any HTTP client can POST messages to the webhook
endpoint.

### Configuration

```yaml
channels:
  webhook:
    port: 3929                        # optional, default 3929
    path: "/hook"                     # optional, URL path
    secret: "whsec_your_secret"       # optional, HMAC verification secret
    budgetPreset: "medium"
```

### Sending a Message

```bash
curl -X POST http://localhost:3929/hook \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-1",
    "text": "Summarize the latest news"
  }'
```

If a `secret` is configured, include an `X-Webhook-Signature` header with the
HMAC-SHA256 hex digest of the request body.
