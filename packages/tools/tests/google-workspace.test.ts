import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configureGoogle,
  gmailSearchTool,
  gmailReadTool,
  gmailSendTool,
  gmailModifyTool,
  gmailDraftTool,
  calendarListTool,
  calendarCreateTool,
  calendarUpdateTool,
  calendarDeleteTool,
} from '../src/builtin/google-workspace.js';

const mockFetch = vi.fn();

describe('Google Workspace Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);

    // Mock the token refresh that happens on every API call
    mockFetch.mockImplementation(async (url: string, opts?: any) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          json: async () => ({
            access_token: 'mock-access-token',
            expires_in: 3600,
          }),
        };
      }
      // Default: return empty OK
      return { ok: true, json: async () => ({}), text: async () => '' };
    });

    configureGoogle({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      refreshToken: 'test-refresh-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Helper to set up API mock after the token refresh
  function mockApiResponse(response: any) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-token', expires_in: 3600 }),
        };
      }
      return {
        ok: true,
        json: async () => response,
        text: async () => JSON.stringify(response),
        status: 200,
      };
    });
  }

  // ─── Tool metadata ───

  describe('tool metadata', () => {
    it('gmail_search has correct name and tags', () => {
      expect(gmailSearchTool.name).toBe('gmail_search');
      expect(gmailSearchTool.tags).toContain('gmail');
    });

    it('gmail_read has correct name and tags', () => {
      expect(gmailReadTool.name).toBe('gmail_read');
      expect(gmailReadTool.tags).toContain('gmail');
    });

    it('gmail_send requires confirmation', () => {
      expect(gmailSendTool.name).toBe('gmail_send');
      expect(gmailSendTool.requiresConfirmation).toBe(true);
    });

    it('gmail_modify has correct name', () => {
      expect(gmailModifyTool.name).toBe('gmail_modify');
    });

    it('gmail_draft has correct name', () => {
      expect(gmailDraftTool.name).toBe('gmail_draft');
    });

    it('calendar_list has correct name and tags', () => {
      expect(calendarListTool.name).toBe('calendar_list');
      expect(calendarListTool.tags).toContain('calendar');
    });

    it('calendar_create requires confirmation', () => {
      expect(calendarCreateTool.name).toBe('calendar_create');
      expect(calendarCreateTool.requiresConfirmation).toBe(true);
    });

    it('calendar_update has correct name', () => {
      expect(calendarUpdateTool.name).toBe('calendar_update');
    });

    it('calendar_delete requires confirmation', () => {
      expect(calendarDeleteTool.name).toBe('calendar_delete');
      expect(calendarDeleteTool.requiresConfirmation).toBe(true);
    });
  });

  // ─── Gmail tools ───

  describe('gmail_search', () => {
    it('returns empty array when no messages found', async () => {
      mockApiResponse({ messages: [], resultSizeEstimate: 0 });

      const result = await gmailSearchTool.execute({
        query: 'is:unread',
        maxResults: 10,
      });

      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.energyMWh).toBeGreaterThan(0);
    });

    it('returns messages with metadata', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            json: async () => ({ access_token: 'mock-token', expires_in: 3600 }),
          };
        }
        callCount++;
        // First call: message list
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              messages: [{ id: 'msg1' }],
              resultSizeEstimate: 1,
            }),
          };
        }
        // Second call: message metadata
        return {
          ok: true,
          json: async () => ({
            id: 'msg1',
            threadId: 'thread1',
            snippet: 'Hello world',
            labelIds: ['INBOX', 'UNREAD'],
            payload: {
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'Subject', value: 'Test Email' },
                { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
              ],
            },
          }),
        };
      });

      const result = await gmailSearchTool.execute({
        query: 'from:alice',
        maxResults: 5,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].from).toBe('alice@example.com');
      expect(result.messages[0].subject).toBe('Test Email');
      expect(result.messages[0].unread).toBe(true);
      expect(result.total).toBe(1);
    });
  });

  describe('gmail_read', () => {
    it('reads a message with full body', async () => {
      const bodyBase64 = Buffer.from('Hello, this is the email body.')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      mockApiResponse({
        id: 'msg123',
        threadId: 'thread123',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'me@example.com' },
            { name: 'Cc', value: '' },
            { name: 'Subject', value: 'Read Test' },
            { name: 'Date', value: 'Tue, 2 Jan 2026 12:00:00 +0000' },
          ],
          body: { data: bodyBase64 },
          parts: [],
        },
      });

      const result = await gmailReadTool.execute({ messageId: 'msg123' });

      expect(result.id).toBe('msg123');
      expect(result.from).toBe('sender@example.com');
      expect(result.subject).toBe('Read Test');
      expect(result.body).toContain('Hello, this is the email body.');
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  describe('gmail_send', () => {
    it('sends an email', async () => {
      mockApiResponse({
        id: 'sent-msg-1',
        threadId: 'thread-sent-1',
      });

      const result = await gmailSendTool.execute({
        to: 'bob@example.com',
        subject: 'Test Send',
        body: 'Hello Bob!',
      });

      expect(result.messageId).toBe('sent-msg-1');
      expect(result.threadId).toBe('thread-sent-1');
      expect(result.energyMWh).toBeGreaterThan(0);

      // Verify the Gmail API was called with POST
      const sendCall = mockFetch.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('messages/send'),
      );
      expect(sendCall).toBeDefined();
      expect(sendCall![1]?.method).toBe('POST');
    });
  });

  describe('gmail_modify', () => {
    it('modifies message labels', async () => {
      mockApiResponse({
        id: 'msg-mod-1',
        labelIds: ['STARRED', 'INBOX'],
      });

      const result = await gmailModifyTool.execute({
        messageId: 'msg-mod-1',
        addLabels: ['STARRED'],
        removeLabels: ['UNREAD'],
      });

      expect(result.success).toBe(true);
      expect(result.labels).toContain('STARRED');
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  describe('gmail_draft', () => {
    it('creates a draft', async () => {
      mockApiResponse({
        id: 'draft-1',
        message: { id: 'msg-draft-1' },
      });

      const result = await gmailDraftTool.execute({
        to: 'charlie@example.com',
        subject: 'Draft Test',
        body: 'This is a draft.',
      });

      expect(result.draftId).toBe('draft-1');
      expect(result.messageId).toBe('msg-draft-1');
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  // ─── Calendar tools ───

  describe('calendar_list', () => {
    it('returns events', async () => {
      mockApiResponse({
        items: [
          {
            id: 'evt1',
            summary: 'Team Standup',
            start: { dateTime: '2026-02-26T09:00:00-05:00' },
            end: { dateTime: '2026-02-26T09:30:00-05:00' },
            location: 'Room 42',
            description: 'Daily standup',
            attendees: [{ email: 'alice@co.com' }, { email: 'bob@co.com' }],
            status: 'confirmed',
            htmlLink: 'https://calendar.google.com/evt1',
          },
        ],
      });

      const result = await calendarListTool.execute({
        maxResults: 10,
        calendarId: 'primary',
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].title).toBe('Team Standup');
      expect(result.events[0].location).toBe('Room 42');
      expect(result.events[0].attendees).toContain('alice@co.com');
      expect(result.energyMWh).toBeGreaterThan(0);
    });

    it('returns empty array for no events', async () => {
      mockApiResponse({ items: [] });

      const result = await calendarListTool.execute({
        maxResults: 10,
        calendarId: 'primary',
      });

      expect(result.events).toEqual([]);
    });
  });

  describe('calendar_create', () => {
    it('creates an event', async () => {
      mockApiResponse({
        id: 'new-evt-1',
        htmlLink: 'https://calendar.google.com/new-evt-1',
      });

      const result = await calendarCreateTool.execute({
        title: 'Lunch Meeting',
        startTime: '2026-03-01T12:00:00-05:00',
        endTime: '2026-03-01T13:00:00-05:00',
        description: 'Lunch with team',
        calendarId: 'primary',
      });

      expect(result.eventId).toBe('new-evt-1');
      expect(result.htmlLink).toContain('calendar.google.com');
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  describe('calendar_update', () => {
    it('updates an event', async () => {
      mockApiResponse({ id: 'evt-update-1' });

      const result = await calendarUpdateTool.execute({
        eventId: 'evt-update-1',
        title: 'Updated Title',
        calendarId: 'primary',
      });

      expect(result.eventId).toBe('evt-update-1');
      expect(result.updated).toBe(true);
      expect(result.energyMWh).toBeGreaterThan(0);

      // Verify PATCH was used
      const patchCall = mockFetch.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('events/evt-update-1'),
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![1]?.method).toBe('PATCH');
    });
  });

  describe('calendar_delete', () => {
    it('deletes an event', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            json: async () => ({ access_token: 'mock-token', expires_in: 3600 }),
          };
        }
        // DELETE returns 204 No Content
        return { ok: true, status: 204, text: async () => '' };
      });

      const result = await calendarDeleteTool.execute({
        eventId: 'evt-del-1',
        calendarId: 'primary',
      });

      expect(result.deleted).toBe(true);
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  // ─── Error handling ───

  describe('error handling', () => {
    it('throws when Google not configured', async () => {
      configureGoogle({ clientId: '', clientSecret: '', refreshToken: '' });

      await expect(
        gmailSearchTool.execute({ query: 'test', maxResults: 5 }),
      ).rejects.toThrow();
    });

    it('throws on API error', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: true,
            json: async () => ({ access_token: 'mock-token', expires_in: 3600 }),
          };
        }
        return {
          ok: false,
          status: 401,
          text: async () => 'Unauthorized',
        };
      });

      await expect(
        gmailSearchTool.execute({ query: 'test', maxResults: 5 }),
      ).rejects.toThrow('Gmail API error');
    });

    it('throws on token refresh failure', async () => {
      // Reset the cached token
      configureGoogle({
        clientId: 'test',
        clientSecret: 'test',
        refreshToken: 'bad-token',
      });

      mockFetch.mockImplementation(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return {
            ok: false,
            status: 400,
            text: async () => 'Invalid grant',
          };
        }
        return { ok: true, json: async () => ({}) };
      });

      await expect(
        gmailSearchTool.execute({ query: 'test', maxResults: 5 }),
      ).rejects.toThrow('Google token refresh failed');
    });
  });
});
