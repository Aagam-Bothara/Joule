import type { SiteKnowledge } from '../types.js';

export const instagram: SiteKnowledge = {
  id: 'instagram',
  name: 'Instagram',
  urlPatterns: ['instagram\\.com', 'instagr\\.am'],
  baseUrl: 'https://www.instagram.com',
  selectors: {
    searchButton: {
      primary: 'a[href*="/explore/"] svg[aria-label="Search"]',
      fallbacks: ['svg[aria-label="Search"]', 'a[href="/explore/"]', 'a[aria-label="Search"]'],
      description: 'Search icon in sidebar navigation',
    },
    searchInput: {
      primary: 'input[aria-label="Search input"]',
      fallbacks: ['input[placeholder="Search"]', 'input[type="text"][aria-label*="Search"]'],
      description: 'Search text input (appears after clicking search icon)',
    },
    profileName: {
      primary: 'header section h2',
      fallbacks: ['header h1', 'header span[dir="auto"]'],
      description: 'Profile username heading',
    },
    profileFullName: {
      primary: 'header section span[dir="auto"]',
      fallbacks: ['header span[style*="font-weight"]'],
      description: 'Profile display name',
    },
    followButton: {
      primary: 'header button[type="button"]',
      fallbacks: ['button[aria-label*="Follow"]', 'div[role="button"][tabindex="0"]'],
      description: 'Follow button on profile page',
    },
    postImage: {
      primary: 'article img[style*="object-fit"]',
      fallbacks: ['article div[role="button"] img', 'article img[alt]'],
      description: 'Post image in feed or post detail',
    },
    likeButton: {
      primary: 'span[aria-label="Like"]',
      fallbacks: ['svg[aria-label="Like"]', 'button svg[aria-label="Like"]'],
      description: 'Like/heart button on a post',
    },
    commentInput: {
      primary: 'textarea[aria-label*="Add a comment"]',
      fallbacks: ['form textarea[placeholder*="comment"]', 'textarea[aria-label*="comment"]'],
      description: 'Comment input box on a post',
    },
    storyRing: {
      primary: 'div[role="button"] canvas',
      fallbacks: ['button[aria-label*="story"]', 'div[role="menuitem"] canvas'],
      description: 'Story ring in the stories tray',
    },
    reelsTab: {
      primary: 'a[href="/reels/"]',
      fallbacks: ['svg[aria-label="Reels"]', 'a[href*="/reels"]'],
      description: 'Reels navigation tab',
    },
  },
  actions: [
    {
      name: 'view_profile',
      steps: [
        'browser_navigate to https://www.instagram.com/USERNAME/',
        'Wait 2 seconds for profile to load',
        'browser_screenshot to see profile info, posts grid, follower count',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'search',
      steps: [
        'browser_navigate to https://www.instagram.com/explore/search/',
        'Wait 1 second',
        'browser_click on the search input',
        'browser_type the search query',
        'Wait 2 seconds for suggestions to appear',
        'browser_screenshot to see search results',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
      tips: ['For hashtag search, navigate directly to instagram.com/explore/tags/HASHTAG/'],
    },
    {
      name: 'view_post',
      steps: [
        'browser_navigate to https://www.instagram.com/p/SHORTCODE/',
        'Wait 2 seconds for post to load',
        'browser_screenshot to see post image, caption, likes, and comments',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'explore_hashtag',
      steps: [
        'browser_navigate to https://www.instagram.com/explore/tags/HASHTAG/',
        'Wait 2 seconds for posts to load',
        'browser_screenshot to see top and recent posts for the hashtag',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
  ],
  tips: [
    'Instagram requires login for most browsing (will redirect to login page)',
    'Direct profile URL: instagram.com/username/',
    'Direct post URL: instagram.com/p/SHORTCODE/',
    'Direct hashtag URL: instagram.com/explore/tags/hashtag/',
    'Direct reel URL: instagram.com/reel/SHORTCODE/',
    'Instagram uses React — most interactive elements are div[role="button"] not actual buttons',
    'Images are lazy-loaded — scroll to trigger loading',
    'CSS classes are obfuscated (like Facebook) — prefer aria-label selectors',
  ],
  gotchas: [
    'Instagram heavily restricts non-logged-in access — login wall appears quickly',
    'Rate limiting is aggressive — slow down between page loads (3-5s)',
    'Stories disappear after 24 hours and require login to view',
    'Some profiles are private — posts won\'t be visible without being a follower',
    'Video content (Reels) autoplays and may need interaction to pause',
    'Instagram may trigger security checkpoints or require 2FA verification',
    'Mobile-first design — some features only available in app, not web',
  ],
  lastVerified: '2026-02-27',
};
