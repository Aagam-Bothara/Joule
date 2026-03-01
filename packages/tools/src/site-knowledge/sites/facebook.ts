import type { SiteKnowledge } from '../types.js';

export const facebook: SiteKnowledge = {
  id: 'facebook',
  name: 'Facebook',
  urlPatterns: ['facebook\\.com', 'fb\\.com', 'fb\\.watch'],
  baseUrl: 'https://www.facebook.com',
  selectors: {
    searchBox: {
      primary: 'input[placeholder="Search Facebook"]',
      fallbacks: ['input[aria-label="Search Facebook"]', 'input[type="search"]'],
      description: 'Global search input',
    },
    postCompose: {
      primary: 'div[aria-label*="Create a post"]',
      fallbacks: ['div[data-pagelet="FeedComposer"] div[role="button"]', 'div[role="button"][tabindex="0"]'],
      description: 'Create post button / composer trigger',
    },
    postTextArea: {
      primary: 'div[contenteditable="true"][role="textbox"][aria-label*="What\'s on your mind"]',
      fallbacks: ['div[contenteditable="true"][data-lexical-editor="true"]', 'form div[contenteditable="true"]'],
      description: 'Post text editor (Lexical-based)',
    },
    postSubmitButton: {
      primary: 'div[aria-label="Post"][role="button"]',
      fallbacks: ['button[name="post"]', 'form div[role="button"][tabindex="0"]'],
      description: 'Submit post button',
    },
    likeButton: {
      primary: 'div[aria-label="Like"][role="button"]',
      fallbacks: ['span[aria-label="Like"]', 'div[role="button"][aria-label*="like" i]'],
      description: 'Like button on a post',
    },
    commentBox: {
      primary: 'div[aria-label="Write a comment"][contenteditable="true"]',
      fallbacks: ['div[placeholder="Write a comment…"]', 'div[data-lexical-editor="true"][aria-label*="comment"]'],
      description: 'Comment input on a post',
    },
    profileName: {
      primary: 'h1[data-testid="profile_name"]',
      fallbacks: ['div[data-pagelet="ProfileTileHeader"] h1', 'h1 span[dir="auto"]'],
      description: 'Profile display name heading',
    },
    messengerButton: {
      primary: 'a[aria-label="Messenger"]',
      fallbacks: ['div[aria-label="Messenger"]', 'a[href*="messenger.com"]'],
      description: 'Messenger icon/link in nav',
    },
    notificationsButton: {
      primary: 'div[aria-label="Notifications"]',
      fallbacks: ['a[aria-label="Notifications"]', 'span[data-testid="notification-badge"]'],
      description: 'Notifications bell icon',
    },
    feedPost: {
      primary: 'div[data-pagelet^="FeedUnit"]',
      fallbacks: ['div[role="article"]', 'div[data-pagelet*="Feed"]'],
      description: 'Individual post in News Feed',
    },
  },
  actions: [
    {
      name: 'search',
      steps: [
        'browser_navigate to https://www.facebook.com/search/top/?q=URL_ENCODED_QUERY',
        'Wait 2 seconds for results to load',
        'browser_screenshot to see search results',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Direct search URL is fastest — avoids needing to find and click the search box'],
    },
    {
      name: 'view_profile',
      steps: [
        'browser_navigate to https://www.facebook.com/USERNAME',
        'Wait 2 seconds for profile to load',
        'browser_screenshot to see profile info',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'create_post',
      steps: [
        'browser_navigate to https://www.facebook.com/',
        'browser_click on "What\'s on your mind" composer area',
        'Wait 1 second for post modal to appear',
        'browser_type the post content in the contenteditable div',
        'browser_click on the "Post" submit button',
        'Wait 2 seconds for post to publish',
        'browser_screenshot to verify post was created',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
    },
  ],
  tips: [
    'Facebook requires login for almost all features',
    'Direct profile URL: facebook.com/username or facebook.com/profile.php?id=NUMERIC_ID',
    'Direct search URL: facebook.com/search/top/?q=query',
    'Facebook uses Lexical (not Quill) for rich text editing — contenteditable divs',
    'Dynamically loaded content — always wait 2+ seconds after navigation',
    'Most elements use role-based ARIA attributes rather than stable CSS classes',
    'CSS class names are auto-generated (e.g., x1heor9g) and change frequently — prefer aria-label and role selectors',
  ],
  gotchas: [
    'Facebook aggressively detects automation — use human-like delays (2-5s between actions)',
    'CSS class names are obfuscated and change with deployments — always prefer aria-label/role selectors',
    'Content is loaded lazily and in response to scroll — may need to scroll to see more posts',
    'Login sessions expire — check for login redirect',
    'Some content is restricted by privacy settings — "This content isn\'t available"',
    'Facebook may show CAPTCHA or security checkpoint for new/suspicious sessions',
  ],
  lastVerified: '2026-02-27',
};
