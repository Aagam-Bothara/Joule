import type { SiteKnowledge } from '../types.js';

export const google: SiteKnowledge = {
  id: 'google',
  name: 'Google Search',
  urlPatterns: ['google\\.com/search', 'google\\.com/?$', 'google\\.co\\.'],
  baseUrl: 'https://www.google.com',
  selectors: {
    searchBox: {
      primary: 'textarea[name="q"]',
      fallbacks: ['input[name="q"]', '#APjFqb', '[aria-label="Search"]'],
      description: 'Main search input/textarea',
    },
    searchButton: {
      primary: 'input[name="btnK"]',
      fallbacks: ['button[aria-label="Google Search"]', '.FPdoLc input[type="submit"]'],
      description: 'Google Search submit button',
    },
    luckyButton: {
      primary: 'input[name="btnI"]',
      fallbacks: ['button[aria-label="I\'m Feeling Lucky"]'],
      description: 'I\'m Feeling Lucky button',
    },
    firstResult: {
      primary: '#search .g a h3',
      fallbacks: ['#rso .g a', '#search a[href]:not([href*="google"]) h3', '.tF2Cxc a'],
      description: 'First organic search result heading',
    },
    firstResultLink: {
      primary: '#search .g a',
      fallbacks: ['#rso .g a', '.tF2Cxc a'],
      description: 'First organic search result link',
    },
    resultSnippets: {
      primary: '.VwiC3b',
      fallbacks: ['.IsZvec', '.s3v9rd', '.st'],
      description: 'Search result description snippets',
    },
    knowledgePanel: {
      primary: '.kp-wholepage',
      fallbacks: ['.knowledge-panel', '#rhs .kp-wholepage'],
      description: 'Knowledge panel (right sidebar)',
    },
    nextPage: {
      primary: '#pnnext',
      fallbacks: ['a[aria-label="Next page"]', 'a#pnnext'],
      description: 'Next page of results',
    },
  },
  actions: [
    {
      name: 'search',
      steps: [
        'browser_navigate to https://www.google.com',
        'browser_type into "textarea[name=\\"q\\"]" with the search query, then press Enter (append \\n)',
        'Wait 1 second for results to load',
        'browser_screenshot to see results',
        'Results are in #search .g elements — each .g is one result',
      ],
      tools: ['browser_navigate', 'browser_type', 'browser_screenshot'],
      tips: [
        'Google now uses <textarea> not <input> for search — use textarea[name="q"]',
        'Append \\n to search text to auto-submit',
        'Results load fast, 1 second wait is usually enough',
      ],
    },
    {
      name: 'search_and_click_first',
      steps: [
        'browser_navigate to https://www.google.com',
        'browser_type into "textarea[name=\\"q\\"]" with query + \\n',
        'Wait 1 second, then browser_click on "#search .g a" to open first result',
      ],
      tools: ['browser_navigate', 'browser_type', 'browser_click', 'browser_screenshot'],
    },
    {
      name: 'direct_search_url',
      steps: [
        'browser_navigate to https://www.google.com/search?q=URL_ENCODED_QUERY',
        'Results load immediately — browser_screenshot to read them',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Fastest approach — skip the typing entirely by going direct to search URL'],
    },
  ],
  tips: [
    'Google changed the search box from <input> to <textarea> — always use textarea[name="q"]',
    'For fastest results, navigate directly to google.com/search?q=your+query',
    'Each search result is wrapped in a .g class div',
    'Featured snippets appear above regular results in .xpdopen',
    'Images tab: add &tbm=isch to URL. Videos: &tbm=vid. News: &tbm=nws',
  ],
  gotchas: [
    'Cookie consent (EU): look for button with "Accept all" text',
    'CAPTCHA may appear if too many requests — switch to a different search if blocked',
    'Google may redirect to a country-specific domain (google.co.in, google.co.uk)',
    'Some results are ads — they have "Sponsored" label. Organic results start after ads',
  ],
  lastVerified: '2026-02-27',
};
