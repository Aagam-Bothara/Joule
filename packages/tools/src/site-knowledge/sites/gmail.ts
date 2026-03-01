import type { SiteKnowledge } from '../types.js';

export const gmail: SiteKnowledge = {
  id: 'gmail',
  name: 'Gmail',
  urlPatterns: ['mail\\.google\\.com'],
  baseUrl: 'https://mail.google.com',
  selectors: {
    composeButton: {
      primary: '[gh="cm"]',
      fallbacks: ['.T-I.T-I-KE', 'div[role="button"][gh="cm"]', '.z0 .L3'],
      description: 'Compose new email button',
    },
    toField: {
      primary: 'input[name="to"]',
      fallbacks: ['textarea[name="to"]', '[aria-label="To recipients"]', 'input[peoplekit-id="BbVjBd"]'],
      description: 'To recipients field in compose',
    },
    subjectField: {
      primary: 'input[name="subjectbox"]',
      fallbacks: ['input[aria-label="Subject"]', '.aoD input'],
      description: 'Subject line field in compose',
    },
    bodyField: {
      primary: 'div[aria-label="Message Body"]',
      fallbacks: ['div[role="textbox"][aria-label*="body" i]', '.Am.Al.editable', 'div.editable[contenteditable="true"]'],
      description: 'Email body (contenteditable div)',
    },
    sendButton: {
      primary: 'div[aria-label*="Send"]',
      fallbacks: ['[role="button"][data-tooltip*="Send"]', '.T-I.J-J5-Ji[aria-label*="Send"]'],
      description: 'Send button in compose window',
    },
    searchBox: {
      primary: 'input[aria-label="Search mail"]',
      fallbacks: ['input[name="q"]', '#gb input[type="text"]'],
      description: 'Gmail search bar',
    },
    inboxLink: {
      primary: 'a[href*="#inbox"]',
      fallbacks: ['[data-tooltip="Inbox"]', '.aim .TO[data-tooltip="Inbox"]'],
      description: 'Inbox navigation link',
    },
    firstEmail: {
      primary: 'tr.zA',
      fallbacks: ['.Cp tr:first-child', 'div[role="main"] tr.zA:first-child'],
      description: 'First email row in list',
    },
    emailSubject: {
      primary: '.hP',
      fallbacks: ['h2.hP', '[data-thread-perm-id] .hP'],
      description: 'Email subject in reading pane',
    },
    replyButton: {
      primary: '[aria-label="Reply"]',
      fallbacks: ['[data-tooltip="Reply"]', '.amn .ams'],
      description: 'Reply button in email view',
    },
  },
  actions: [
    {
      name: 'compose_and_send',
      steps: [
        'browser_navigate to https://mail.google.com (must be logged in)',
        'browser_click on compose button: [gh="cm"]',
        'Wait 1 second for compose window to appear',
        'browser_type into input[name="to"] with recipient email',
        'Press Tab to move to subject, or browser_click on input[name="subjectbox"]',
        'browser_type the subject line',
        'browser_click on div[aria-label="Message Body"]',
        'browser_type the email body',
        'browser_click on div[aria-label*="Send"] to send',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
      tips: [
        'Gmail requires authentication — agent must be logged in already',
        'The body is a contenteditable div, not an input/textarea',
        'Use Tab to navigate between To, Subject, and Body fields',
      ],
    },
    {
      name: 'search_emails',
      steps: [
        'browser_navigate to https://mail.google.com',
        'browser_click on input[aria-label="Search mail"]',
        'browser_type the search query + \\n',
        'Wait 2 seconds for results, then browser_screenshot',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
    },
    {
      name: 'read_first_email',
      steps: [
        'browser_navigate to https://mail.google.com',
        'Wait 2 seconds for inbox to load',
        'browser_click on "tr.zA" to open first email',
        'Wait 1 second, then browser_screenshot to read the email',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_screenshot'],
    },
  ],
  tips: [
    'Gmail uses heavy JavaScript — always wait 2+ seconds after navigation',
    'Compose window is a modal overlay, not a new page',
    'Email body is contenteditable div — use browser_type, not input filling',
    'Use Ctrl+Enter shortcut to send email (faster than clicking Send)',
    'Gmail search operators: from:, to:, subject:, has:attachment, is:unread',
  ],
  gotchas: [
    'Must be authenticated — if not logged in, you\'ll see Google sign-in page',
    'Gmail has multiple loading states — wait for .z0 (compose button) to confirm inbox loaded',
    'The compose window uses contenteditable — some browser_type implementations may need click first',
    'Attachments: use the attachment button + file input, not drag-and-drop',
  ],
  lastVerified: '2026-02-27',
};
