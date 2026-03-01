import type { SiteKnowledge } from '../types.js';

export const chatgpt: SiteKnowledge = {
  id: 'chatgpt',
  name: 'ChatGPT',
  urlPatterns: ['chatgpt\\.com', 'chat\\.openai\\.com'],
  baseUrl: 'https://chatgpt.com',
  selectors: {
    promptInput: {
      primary: 'div#prompt-textarea[contenteditable="true"]',
      fallbacks: ['textarea#prompt-textarea', 'div[data-placeholder*="Message"]', 'form textarea'],
      description: 'Main chat input area',
    },
    sendButton: {
      primary: 'button[data-testid="send-button"]',
      fallbacks: ['button[aria-label="Send prompt"]', 'form button[type="submit"]'],
      description: 'Send message button',
    },
    newChatButton: {
      primary: 'a[href="/"]',
      fallbacks: ['button[aria-label*="New chat"]', 'nav a[href="/"]'],
      description: 'Start new chat button',
    },
    modelSelector: {
      primary: 'button[aria-haspopup="menu"][data-testid="model-selector"]',
      fallbacks: ['button[aria-haspopup="menu"]', 'div[class*="model-switcher"]'],
      description: 'Model selector dropdown (GPT-4, GPT-4o, etc.)',
    },
    chatMessage: {
      primary: 'div[data-message-author-role]',
      fallbacks: ['div.markdown', 'div[class*="message"]'],
      description: 'Individual chat message (user or assistant)',
    },
    assistantMessage: {
      primary: 'div[data-message-author-role="assistant"]',
      fallbacks: ['div.agent-turn div.markdown', 'div[class*="assistant-message"]'],
      description: 'Assistant response message',
    },
    sidebarConversation: {
      primary: 'nav a[href^="/c/"]',
      fallbacks: ['nav li a[href*="/c/"]', 'div[data-testid*="conversation"]'],
      description: 'Conversation link in sidebar history',
    },
    stopButton: {
      primary: 'button[aria-label="Stop generating"]',
      fallbacks: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'],
      description: 'Stop generation button (appears during response)',
    },
    copyButton: {
      primary: 'button[aria-label="Copy"]',
      fallbacks: ['button[data-testid="copy-turn-action-button"]', 'button[aria-label*="Copy"]'],
      description: 'Copy response button',
    },
    regenerateButton: {
      primary: 'button[aria-label="Regenerate"]',
      fallbacks: ['button[data-testid="regenerate-button"]', 'button[aria-label*="Regenerate"]'],
      description: 'Regenerate response button',
    },
  },
  actions: [
    {
      name: 'send_message',
      steps: [
        'browser_navigate to https://chatgpt.com/',
        'Wait 2 seconds for page to load',
        'browser_click on the prompt input area (div#prompt-textarea)',
        'browser_type the message',
        'browser_click the send button or press Enter',
        'Wait for response — watch for the stop button to appear then disappear',
        'browser_screenshot to read the response',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
      tips: ['Response generation can take 5-30 seconds depending on model and prompt length'],
    },
    {
      name: 'new_chat',
      steps: [
        'browser_navigate to https://chatgpt.com/',
        'Wait 1 second',
        'browser_screenshot to confirm new chat page',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Navigating to the root URL always starts a new chat'],
    },
    {
      name: 'read_conversation',
      steps: [
        'browser_navigate to https://chatgpt.com/c/CONVERSATION_ID',
        'Wait 2 seconds for conversation to load',
        'browser_screenshot to read messages',
        'Scroll down if conversation is long and take more screenshots',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
  ],
  tips: [
    'ChatGPT requires login (OpenAI account, Google, Microsoft, or Apple)',
    'Direct chat URL: chatgpt.com/ (new chat) or chatgpt.com/c/CONVERSATION_ID',
    'The prompt input is a contenteditable div, not a textarea',
    'Response streaming means the page updates continuously during generation',
    'Wait for the stop button to disappear to know when generation is complete',
    'Model can be switched via the dropdown at the top of a new chat',
    'ChatGPT Plus/Pro users have access to GPT-4o, o1, o3 models',
  ],
  gotchas: [
    'Login is mandatory — no anonymous access to chat',
    'Rate limits apply — free tier has message caps per time window',
    'Response generation can be slow (10-60s for complex prompts)',
    'The stop button appears during generation — don\'t try to interact until generation completes',
    'File upload and image generation features require Plus subscription',
    'Sessions can expire — check for login redirect',
    'CAPTCHA may appear during login flow',
  ],
  lastVerified: '2026-02-27',
};
