import type { SiteKnowledge } from '../types.js';

export const github: SiteKnowledge = {
  id: 'github',
  name: 'GitHub',
  urlPatterns: ['github\\.com'],
  baseUrl: 'https://github.com',
  selectors: {
    searchBox: {
      primary: 'input[name="query-builder-test"]',
      fallbacks: ['input.header-search-input', '#query-builder-test', '[data-target="query-builder.input"]'],
      description: 'Global search input',
    },
    repoName: {
      primary: '[itemprop="name"] a',
      fallbacks: ['.AppHeader-context-item-label', 'strong[itemprop="name"] a'],
      description: 'Repository name on repo page',
    },
    fileExplorer: {
      primary: '[aria-labelledby="files"]',
      fallbacks: ['.js-navigation-container', 'table[aria-labelledby="folders-and-files"]'],
      description: 'File tree/explorer',
    },
    codeContent: {
      primary: '.blob-code-content',
      fallbacks: ['[data-code-text]', '.highlight .blob-code', 'table.highlight td.blob-code'],
      description: 'Code content in file viewer',
    },
    issuesTab: {
      primary: 'a#issues-tab',
      fallbacks: ['a[data-tab-item="i-issues"]', 'nav a[href*="/issues"]'],
      description: 'Issues tab on repo',
    },
    prTab: {
      primary: 'a#pull-requests-tab',
      fallbacks: ['a[data-tab-item="i-pull-requests"]', 'nav a[href*="/pulls"]'],
      description: 'Pull requests tab',
    },
    newIssueButton: {
      primary: 'a[href$="/issues/new/choose"]',
      fallbacks: ['a.btn-primary[href*="issues/new"]', 'a[data-hotkey="c"]'],
      description: 'New issue button',
    },
    starButton: {
      primary: 'button[data-ga-click*="star"]',
      fallbacks: ['.starring-container button', 'form.js-social-form button'],
      description: 'Star/unstar repo button',
    },
    profileMenu: {
      primary: 'button[aria-label="Open user navigation menu"]',
      fallbacks: ['details summary[aria-label*="user"]', '.Header-link img.avatar'],
      description: 'User profile dropdown',
    },
  },
  actions: [
    {
      name: 'search_repos',
      steps: [
        'browser_navigate to https://github.com/search?q=QUERY&type=repositories',
        'Results load immediately — browser_screenshot to read',
        'Each result is a .Box-row or repo-list-item element',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Direct URL search is fastest — skip the search box interaction'],
    },
    {
      name: 'view_repo',
      steps: [
        'browser_navigate to https://github.com/OWNER/REPO',
        'browser_screenshot to see README and file tree',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'view_file',
      steps: [
        'browser_navigate to https://github.com/OWNER/REPO/blob/BRANCH/PATH/TO/FILE',
        'browser_screenshot to read code',
        'Or use browser_extract to get the text content from .blob-code-content',
      ],
      tools: ['browser_navigate', 'browser_screenshot', 'browser_extract'],
    },
    {
      name: 'create_issue',
      steps: [
        'browser_navigate to https://github.com/OWNER/REPO/issues/new',
        'browser_type into input#issue_title with the issue title',
        'browser_click on textarea#issue_body (or [name="issue[body]"])',
        'browser_type the issue description',
        'browser_click on button[type="submit"] containing "Submit new issue"',
      ],
      tools: ['browser_navigate', 'browser_type', 'browser_click', 'browser_screenshot'],
    },
  ],
  tips: [
    'Use direct URLs for maximum speed — github.com/OWNER/REPO/blob/main/file.ts',
    'Raw file content: raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH',
    'GitHub API is often better than browser for data: api.github.com/repos/OWNER/REPO',
    'Use ?tab=repositories on profile pages to see repos',
    'Search syntax: language:typescript stars:>1000 topic:ai',
  ],
  gotchas: [
    'GitHub uses Turbo/SPA navigation — page may not fully reload on clicks',
    'Must be logged in for: creating issues, starring, forking, viewing private repos',
    'Rate limits on API: 60/hr unauthenticated, 5000/hr authenticated',
    'Some elements load lazily — wait 1-2 seconds after navigation',
  ],
  lastVerified: '2026-02-27',
};
