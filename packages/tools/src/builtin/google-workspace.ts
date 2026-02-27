/**
 * Google Workspace Tools — Gmail + Calendar
 *
 * Uses Google REST APIs directly (no googleapis dependency).
 * OAuth2 refresh token flow for authentication.
 */
import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';

// ── Google OAuth2 Client ────────────────────────────────────────────────────

interface GoogleOAuthState {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

let oauth: GoogleOAuthState | null = null;

export function configureGoogle(config: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  oauth = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
  };
}

async function getAccessToken(): Promise<string> {
  if (!oauth) throw new Error('Google OAuth not configured. Run `joule auth google` first.');
  if (!oauth.refreshToken) throw new Error('No refresh token. Run `joule auth google` first.');

  // Return cached token if still valid
  if (oauth.accessToken && oauth.expiresAt && Date.now() < oauth.expiresAt - 30_000) {
    return oauth.accessToken;
  }

  // Refresh the token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: oauth.clientId,
      client_secret: oauth.clientSecret,
      refresh_token: oauth.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  oauth.accessToken = data.access_token;
  oauth.expiresAt = Date.now() + data.expires_in * 1000;
  return oauth.accessToken!;
}

async function gmailApi(path: string, options?: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API error: ${res.status} ${err}`);
  }
  return res.json();
}

async function calendarApi(path: string, options?: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Calendar API error: ${res.status} ${err}`);
  }
  return res.json();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function decodeBase64Url(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function encodeBase64Url(str: string): string {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function extractHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function parseMessagePayload(payload: any): string {
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    // Prefer text/plain, fallback to text/html
    const plain = payload.parts.find((p: any) => p.mimeType === 'text/plain');
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    const html = payload.parts.find((p: any) => p.mimeType === 'text/html');
    if (html?.body?.data) {
      const raw = decodeBase64Url(html.body.data);
      // Strip HTML tags for plain text
      return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      if (part.parts) return parseMessagePayload(part);
    }
  }
  return '';
}

// ── Gmail Tools ─────────────────────────────────────────────────────────────

// 1. gmail_search
export const gmailSearchTool: ToolDefinition = {
  name: 'gmail_search',
  description:
    'Search emails in Gmail using query syntax. Supports Gmail search operators ' +
    'like "is:unread", "from:user@example.com", "subject:hello", "has:attachment", etc.',
  inputSchema: z.object({
    query: z.string().describe('Gmail search query (e.g. "is:unread", "from:boss@company.com")'),
    maxResults: z.number().optional().default(10).describe('Max emails to return (default 10)'),
  }),
  outputSchema: z.object({
    messages: z.array(z.object({
      id: z.string(),
      threadId: z.string(),
      from: z.string(),
      subject: z.string(),
      snippet: z.string(),
      date: z.string(),
      unread: z.boolean(),
      labels: z.array(z.string()),
    })),
    total: z.number(),
    energyMWh: z.number(),
  }),
  tags: ['gmail', 'email'],

  async execute(input) {
    const listData = await gmailApi(
      `messages?q=${encodeURIComponent(input.query)}&maxResults=${input.maxResults}`,
    );

    const messageIds: string[] = (listData.messages || []).map((m: any) => m.id);
    if (messageIds.length === 0) {
      return { messages: [], total: 0, energyMWh: 0.01 };
    }

    // Fetch metadata for each message (batch would be better but keep it simple)
    const messages = await Promise.all(
      messageIds.map(async (id) => {
        const msg = await gmailApi(`messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const headers = msg.payload?.headers || [];
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: extractHeader(headers, 'From'),
          subject: extractHeader(headers, 'Subject'),
          snippet: msg.snippet || '',
          date: extractHeader(headers, 'Date'),
          unread: (msg.labelIds || []).includes('UNREAD'),
          labels: msg.labelIds || [],
        };
      }),
    );

    return {
      messages,
      total: listData.resultSizeEstimate || messages.length,
      energyMWh: 0.01 * messages.length,
    };
  },
};

// 2. gmail_read
export const gmailReadTool: ToolDefinition = {
  name: 'gmail_read',
  description: 'Read the full content of a specific email by its message ID.',
  inputSchema: z.object({
    messageId: z.string().describe('Gmail message ID'),
  }),
  outputSchema: z.object({
    id: z.string(),
    threadId: z.string(),
    from: z.string(),
    to: z.string(),
    cc: z.string(),
    subject: z.string(),
    date: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
    attachments: z.array(z.object({ filename: z.string(), mimeType: z.string(), size: z.number() })),
    energyMWh: z.number(),
  }),
  tags: ['gmail', 'email'],

  async execute(input) {
    const msg = await gmailApi(`messages/${input.messageId}?format=full`);
    const headers = msg.payload?.headers || [];
    const body = parseMessagePayload(msg.payload);

    const attachments = (msg.payload?.parts || [])
      .filter((p: any) => p.filename && p.filename.length > 0)
      .map((p: any) => ({
        filename: p.filename,
        mimeType: p.mimeType,
        size: parseInt(p.body?.size || '0', 10),
      }));

    return {
      id: msg.id,
      threadId: msg.threadId,
      from: extractHeader(headers, 'From'),
      to: extractHeader(headers, 'To'),
      cc: extractHeader(headers, 'Cc'),
      subject: extractHeader(headers, 'Subject'),
      date: extractHeader(headers, 'Date'),
      body: body.slice(0, 10_000), // Limit body size for LLM context
      labels: msg.labelIds || [],
      attachments,
      energyMWh: 0.015,
    };
  },
};

// 3. gmail_send
export const gmailSendTool: ToolDefinition = {
  name: 'gmail_send',
  description:
    'Send an email via Gmail. Can also reply to an existing thread by providing replyToMessageId.',
  inputSchema: z.object({
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.string().optional().describe('CC recipients (comma-separated)'),
    bcc: z.string().optional().describe('BCC recipients (comma-separated)'),
    replyToMessageId: z.string().optional().describe('Message ID to reply to (for threading)'),
  }),
  outputSchema: z.object({
    messageId: z.string(),
    threadId: z.string(),
    energyMWh: z.number(),
  }),
  tags: ['gmail', 'email'],
  requiresConfirmation: true,

  async execute(input) {
    let headers = `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
    if (input.cc) headers += `Cc: ${input.cc}\r\n`;
    if (input.bcc) headers += `Bcc: ${input.bcc}\r\n`;

    let threadId: string | undefined;

    // If replying, fetch original message for threading headers
    if (input.replyToMessageId) {
      const original = await gmailApi(`messages/${input.replyToMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`);
      const origHeaders = original.payload?.headers || [];
      const messageIdHeader = extractHeader(origHeaders, 'Message-ID');
      if (messageIdHeader) {
        headers += `In-Reply-To: ${messageIdHeader}\r\nReferences: ${messageIdHeader}\r\n`;
      }
      threadId = original.threadId;
    }

    const raw = encodeBase64Url(`${headers}\r\n${input.body}`);

    const payload: any = { raw };
    if (threadId) payload.threadId = threadId;

    const result = await gmailApi('messages/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    return {
      messageId: result.id,
      threadId: result.threadId,
      energyMWh: 0.02,
    };
  },
};

// 4. gmail_modify
export const gmailModifyTool: ToolDefinition = {
  name: 'gmail_modify',
  description:
    'Modify email labels — archive, star, mark as read/unread, trash, etc.',
  inputSchema: z.object({
    messageId: z.string().describe('Gmail message ID'),
    addLabels: z.array(z.string()).optional().describe('Labels to add (e.g. ["STARRED", "IMPORTANT"])'),
    removeLabels: z.array(z.string()).optional().describe('Labels to remove (e.g. ["UNREAD", "INBOX"])'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    labels: z.array(z.string()),
    energyMWh: z.number(),
  }),
  tags: ['gmail', 'email'],

  async execute(input) {
    const result = await gmailApi(`messages/${input.messageId}/modify`, {
      method: 'POST',
      body: JSON.stringify({
        addLabelIds: input.addLabels || [],
        removeLabelIds: input.removeLabels || [],
      }),
    });

    return {
      success: true,
      labels: result.labelIds || [],
      energyMWh: 0.005,
    };
  },
};

// 5. gmail_draft
export const gmailDraftTool: ToolDefinition = {
  name: 'gmail_draft',
  description: 'Create a draft email in Gmail (does not send it).',
  inputSchema: z.object({
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
  }),
  outputSchema: z.object({
    draftId: z.string(),
    messageId: z.string(),
    energyMWh: z.number(),
  }),
  tags: ['gmail', 'email'],

  async execute(input) {
    const headers = `To: ${input.to}\r\nSubject: ${input.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
    const raw = encodeBase64Url(`${headers}\r\n${input.body}`);

    const result = await gmailApi('drafts', {
      method: 'POST',
      body: JSON.stringify({ message: { raw } }),
    });

    return {
      draftId: result.id,
      messageId: result.message?.id || '',
      energyMWh: 0.01,
    };
  },
};

// ── Calendar Tools ──────────────────────────────────────────────────────────

// 1. calendar_list
export const calendarListTool: ToolDefinition = {
  name: 'calendar_list',
  description:
    'List upcoming calendar events. Defaults to next 7 days if no time range specified.',
  inputSchema: z.object({
    timeMin: z.string().optional().describe('Start time (ISO 8601). Defaults to now.'),
    timeMax: z.string().optional().describe('End time (ISO 8601). Defaults to 7 days from now.'),
    maxResults: z.number().optional().default(20).describe('Max events to return'),
    calendarId: z.string().optional().default('primary').describe('Calendar ID (default: primary)'),
  }),
  outputSchema: z.object({
    events: z.array(z.object({
      id: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string(),
      location: z.string(),
      description: z.string(),
      attendees: z.array(z.string()),
      status: z.string(),
      htmlLink: z.string(),
    })),
    energyMWh: z.number(),
  }),
  tags: ['calendar', 'google'],

  async execute(input) {
    const now = new Date();
    const timeMin = input.timeMin || now.toISOString();
    const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const timeMax = input.timeMax || weekLater.toISOString();

    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: String(input.maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    const data = await calendarApi(
      `calendars/${encodeURIComponent(input.calendarId)}/events?${params}`,
    );

    const events = (data.items || []).map((evt: any) => ({
      id: evt.id,
      title: evt.summary || '(no title)',
      start: evt.start?.dateTime || evt.start?.date || '',
      end: evt.end?.dateTime || evt.end?.date || '',
      location: evt.location || '',
      description: (evt.description || '').slice(0, 500),
      attendees: (evt.attendees || []).map((a: any) => a.email),
      status: evt.status || 'confirmed',
      htmlLink: evt.htmlLink || '',
    }));

    return { events, energyMWh: 0.01 };
  },
};

// 2. calendar_create
export const calendarCreateTool: ToolDefinition = {
  name: 'calendar_create',
  description: 'Create a new calendar event.',
  inputSchema: z.object({
    title: z.string().describe('Event title/summary'),
    startTime: z.string().describe('Start time (ISO 8601, e.g. "2026-03-01T10:00:00-05:00")'),
    endTime: z.string().describe('End time (ISO 8601)'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    htmlLink: z.string(),
    energyMWh: z.number(),
  }),
  tags: ['calendar', 'google'],
  requiresConfirmation: true,

  async execute(input) {
    const event: any = {
      summary: input.title,
      start: { dateTime: input.startTime },
      end: { dateTime: input.endTime },
    };
    if (input.description) event.description = input.description;
    if (input.location) event.location = input.location;
    if (input.attendees) event.attendees = input.attendees.map((email: string) => ({ email }));

    const result = await calendarApi(
      `calendars/${encodeURIComponent(input.calendarId)}/events`,
      { method: 'POST', body: JSON.stringify(event) },
    );

    return {
      eventId: result.id,
      htmlLink: result.htmlLink || '',
      energyMWh: 0.015,
    };
  },
};

// 3. calendar_update
export const calendarUpdateTool: ToolDefinition = {
  name: 'calendar_update',
  description: 'Update an existing calendar event.',
  inputSchema: z.object({
    eventId: z.string().describe('Event ID to update'),
    title: z.string().optional().describe('New title'),
    startTime: z.string().optional().describe('New start time (ISO 8601)'),
    endTime: z.string().optional().describe('New end time (ISO 8601)'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    updated: z.boolean(),
    energyMWh: z.number(),
  }),
  tags: ['calendar', 'google'],

  async execute(input) {
    const patch: any = {};
    if (input.title) patch.summary = input.title;
    if (input.startTime) patch.start = { dateTime: input.startTime };
    if (input.endTime) patch.end = { dateTime: input.endTime };
    if (input.description) patch.description = input.description;
    if (input.location) patch.location = input.location;

    await calendarApi(
      `calendars/${encodeURIComponent(input.calendarId)}/events/${input.eventId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );

    return { eventId: input.eventId, updated: true, energyMWh: 0.01 };
  },
};

// 4. calendar_delete
export const calendarDeleteTool: ToolDefinition = {
  name: 'calendar_delete',
  description: 'Delete a calendar event.',
  inputSchema: z.object({
    eventId: z.string().describe('Event ID to delete'),
    calendarId: z.string().optional().default('primary').describe('Calendar ID'),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    energyMWh: z.number(),
  }),
  tags: ['calendar', 'google'],
  requiresConfirmation: true,

  async execute(input) {
    const token = await getAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events/${input.eventId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );

    if (!res.ok && res.status !== 204) {
      const err = await res.text();
      throw new Error(`Calendar delete failed: ${res.status} ${err}`);
    }

    return { deleted: true, energyMWh: 0.005 };
  },
};
