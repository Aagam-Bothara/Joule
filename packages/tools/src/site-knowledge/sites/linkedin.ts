import type { SiteKnowledge } from '../types.js';

export const linkedin: SiteKnowledge = {
  id: 'linkedin',
  name: 'LinkedIn',
  urlPatterns: ['linkedin\\.com'],
  baseUrl: 'https://www.linkedin.com',
  selectors: {
    searchBox: {
      primary: 'input.search-global-typeahead__input',
      fallbacks: ['input[placeholder="Search"]', 'input[aria-label="Search"]'],
      description: 'Global search input',
    },
    postCompose: {
      primary: 'button.share-box-feed-entry__trigger',
      fallbacks: ['[data-control-name="share.share_box"]', 'button[aria-label*="Start a post"]'],
      description: 'Start a post button',
    },
    postTextArea: {
      primary: 'div.ql-editor',
      fallbacks: ['div[role="textbox"][contenteditable="true"]', '.share-creation-state__text-editor .ql-editor'],
      description: 'Post text editor (Quill-based)',
    },
    postButton: {
      primary: 'button.share-actions__primary-action',
      fallbacks: ['button[data-control-name="share.post"]', 'button[aria-label*="Post"]'],
      description: 'Submit post button',
    },
    connectButton: {
      primary: 'button[aria-label*="Connect"]',
      fallbacks: ['button.pvs-profile-actions__action[aria-label*="Connect"]'],
      description: 'Connect with person button',
    },
    messageButton: {
      primary: 'button[aria-label*="Message"]',
      fallbacks: ['a.message-anywhere-button', 'button.pvs-profile-actions__action[aria-label*="Message"]'],
      description: 'Send message button on profile',
    },
    feedPost: {
      primary: 'div.feed-shared-update-v2',
      fallbacks: ['[data-urn*="activity"]', '.occludable-update'],
      description: 'Individual post in feed',
    },
    profileName: {
      primary: 'h1.text-heading-xlarge',
      fallbacks: ['.pv-text-details__left-panel h1', '.top-card-layout__title'],
      description: 'Profile name heading',
    },
    profileHeadline: {
      primary: 'div.text-body-medium.break-words',
      fallbacks: ['.pv-text-details__left-panel .text-body-medium', '.top-card-layout__headline'],
      description: 'Profile headline/tagline',
    },
  },
  actions: [
    {
      name: 'search_people',
      steps: [
        'browser_navigate to https://www.linkedin.com/search/results/people/?keywords=URL_ENCODED_QUERY',
        'Wait 2 seconds for results to load',
        'browser_screenshot to see profiles',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'view_profile',
      steps: [
        'browser_navigate to https://www.linkedin.com/in/USERNAME/',
        'Wait 2 seconds for profile to load',
        'browser_screenshot to read profile details',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'create_post',
      steps: [
        'browser_navigate to https://www.linkedin.com/feed/',
        'browser_click on button with text "Start a post" (button.share-box-feed-entry__trigger)',
        'Wait 1 second for modal to appear',
        'browser_click on div.ql-editor',
        'browser_type the post content',
        'browser_click on button.share-actions__primary-action to post',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
    },
  ],
  tips: [
    'LinkedIn requires authentication for everything — must be logged in',
    'Direct profile URL: linkedin.com/in/username/',
    'Search with filters in URL: /search/results/people/?keywords=query&network=["F"] for 1st connections',
    'Post editor uses Quill.js — the textbox is a div.ql-editor, not textarea',
    'LinkedIn loads content lazily — always wait 2+ seconds',
  ],
  gotchas: [
    'LinkedIn aggressively blocks automation — use delays between actions',
    'Session may expire — check for login redirect',
    'Profile pages have different layouts for own profile vs others',
    'Some features are Premium-only (InMail, detailed analytics)',
    'Connection requests have weekly limits (~100/week)',
  ],
  lastVerified: '2026-02-27',
};
