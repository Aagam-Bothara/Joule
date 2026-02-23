# @joule/channels

Messaging platform integrations for Joule. Provides adapters for 11 messaging
platforms, all built on a common `BaseChannel` abstract class.

## Installation

```bash
pnpm add @joule/channels
```

Slack and Discord are included as direct dependencies. Other platforms require
installing optional peer dependencies:

```bash
pnpm add telegraf              # Telegram
pnpm add whatsapp-web.js       # WhatsApp
pnpm add botbuilder            # Microsoft Teams
pnpm add nodemailer imap       # Email
pnpm add matrix-js-sdk         # Matrix
pnpm add irc-framework         # IRC
pnpm add twilio                # Twilio SMS
```

## Key Exports

### Channel Classes

| Class              | Platform        |
| ------------------ | --------------- |
| `SlackChannel`     | Slack           |
| `DiscordChannel`   | Discord         |
| `TelegramChannel`  | Telegram        |
| `WhatsAppChannel`  | WhatsApp        |
| `SignalChannel`    | Signal          |
| `TeamsChannel`     | Microsoft Teams |
| `EmailChannel`     | Email (IMAP/SMTP) |
| `MatrixChannel`    | Matrix          |
| `IrcChannel`       | IRC             |
| `TwilioSmsChannel` | Twilio SMS      |
| `WebhookChannel`   | HTTP Webhook    |

### Base Class

- `BaseChannel` -- abstract base class all channels extend

### Types

- `ChannelMessage` -- normalized incoming message
- `ChannelResponse` -- outgoing response with optional metadata
- `ChannelConfig` -- union of all channel configuration interfaces
- `SlackChannelConfig`, `DiscordChannelConfig`, `TelegramChannelConfig`,
  `WhatsAppChannelConfig`, `SignalChannelConfig`, `TeamsChannelConfig`,
  `EmailChannelConfig`, `MatrixChannelConfig`, `IrcChannelConfig`,
  `TwilioSmsChannelConfig`, `WebhookChannelConfig` -- per-platform configs
- `Attachment` -- file attachment type

### Utilities

- `splitMessage(text, limit)` -- split a long message for Discord's character limit
- `splitTelegramMessage(text, limit)` -- split a long message for Telegram

## Usage

```typescript
import { SlackChannel } from '@joule/channels';
import type { SlackChannelConfig } from '@joule/channels';
import { Joule } from '@joule/core';

const joule = new Joule();
// ... register providers and tools ...

const config: SlackChannelConfig = {
  botToken: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  budgetPreset: 'medium',
};

const slack = new SlackChannel(config, joule);
await slack.connect();

// The channel automatically handles incoming messages and sends responses.
// To shut down:
await slack.disconnect();
```

See `docs/channels.md` for detailed setup instructions for each platform.
