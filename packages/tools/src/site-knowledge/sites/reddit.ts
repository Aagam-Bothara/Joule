import type { SiteKnowledge } from '../types.js';

export const reddit: SiteKnowledge = {
  id: 'reddit',
  name: 'Reddit',
  urlPatterns: ['reddit\\.com', 'old\\.reddit\\.com', 'redd\\.it'],
  baseUrl: 'https://www.reddit.com',
  selectors: {
    searchBox: {
      primary: 'input[name="q"]',
      fallbacks: ['input[type="search"]', 'faceplate-search-input input', 'input[placeholder*="Search"]'],
      description: 'Global search input',
    },
    postTitle: {
      primary: 'a[data-testid="post-title"]',
      fallbacks: ['shreddit-post h1', 'div[data-click-id="body"] h3', 'a[slot="title"]'],
      description: 'Post title link',
    },
    postBody: {
      primary: 'div[data-testid="post-content"]',
      fallbacks: ['shreddit-post div[slot="text-body"]', 'div[data-click-id="text"]', 'div.md'],
      description: 'Post text content body',
    },
    upvoteButton: {
      primary: 'button[aria-label="upvote"]',
      fallbacks: ['shreddit-post button[upvote]', 'div[data-click-id="upvote"]'],
      description: 'Upvote button on a post or comment',
    },
    commentInput: {
      primary: 'div[contenteditable="true"][aria-label*="comment"]',
      fallbacks: ['shreddit-composer div[contenteditable="true"]', 'textarea[placeholder*="comment"]'],
      description: 'Comment text input area',
    },
    subredditName: {
      primary: 'a[data-testid="subreddit-name"]',
      fallbacks: ['shreddit-subreddit-header a[href^="/r/"]', 'h1 a[href*="/r/"]'],
      description: 'Subreddit name/link on community page',
    },
    sortDropdown: {
      primary: 'button[aria-label*="Sort"]',
      fallbacks: ['shreddit-sort-dropdown button', 'div[data-testid="sort-button"]'],
      description: 'Sort posts dropdown (Hot, New, Top, etc.)',
    },
    joinButton: {
      primary: 'button[aria-label*="Join"]',
      fallbacks: ['shreddit-subreddit-header button', 'button[data-testid="join-button"]'],
      description: 'Join subreddit button',
    },
    feedPost: {
      primary: 'shreddit-post',
      fallbacks: ['article', 'div[data-testid="post-container"]', 'div.thing'],
      description: 'Individual post in feed',
    },
    commentThread: {
      primary: 'shreddit-comment-tree shreddit-comment',
      fallbacks: ['div[data-testid="comment"]', 'div.comment', 'div[id^="t1_"]'],
      description: 'Individual comment in thread',
    },
  },
  actions: [
    {
      name: 'search',
      steps: [
        'browser_navigate to https://www.reddit.com/search/?q=URL_ENCODED_QUERY',
        'Wait 2 seconds for results to load',
        'browser_screenshot to see search results',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: [
        'Add &type=link for posts, &type=sr for subreddits, &type=comment for comments',
        'Add &sort=relevance or &sort=new or &sort=top for sorting',
      ],
    },
    {
      name: 'view_subreddit',
      steps: [
        'browser_navigate to https://www.reddit.com/r/SUBREDDIT_NAME/',
        'Wait 2 seconds for posts to load',
        'browser_screenshot to see community and posts',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'view_post',
      steps: [
        'browser_navigate to the full post URL (reddit.com/r/sub/comments/ID/title/)',
        'Wait 2 seconds for comments to load',
        'browser_screenshot to read post and top comments',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Append ?sort=top or ?sort=best to sort comments'],
    },
    {
      name: 'search_subreddit',
      steps: [
        'browser_navigate to https://www.reddit.com/r/SUBREDDIT/search/?q=QUERY&restrict_sr=1',
        'Wait 2 seconds for results',
        'browser_screenshot to see results within the subreddit',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['restrict_sr=1 limits search to that subreddit only'],
    },
  ],
  tips: [
    'Reddit is mostly accessible without login (reading posts and comments)',
    'Direct subreddit URL: reddit.com/r/subreddit_name/',
    'Direct post URL: reddit.com/r/sub/comments/POST_ID/title/',
    'Direct user profile: reddit.com/u/username/ or reddit.com/user/username/',
    'Search within subreddit: reddit.com/r/sub/search/?q=query&restrict_sr=1',
    'Sort posts: append ?sort=hot|new|top|rising to subreddit URLs',
    'Top posts time filter: ?sort=top&t=hour|day|week|month|year|all',
    'Reddit uses "shreddit" web components (custom elements) — look for shreddit-post, shreddit-comment',
    'Old Reddit (old.reddit.com) has simpler DOM but different selectors',
  ],
  gotchas: [
    'Reddit may show a login popup/modal that blocks content — dismiss or navigate around it',
    'NSFW subreddits require login and age verification',
    'Reddit rate-limits non-logged-in browsing — may show "rate limit exceeded" page',
    'New Reddit uses web components (shreddit-*) which can be harder to query',
    'Some subreddits are quarantined — require explicit opt-in to view',
    'Comments load lazily in deep threads — "Continue this thread" links',
    'Reddit redesign means selectors change — the site has two versions (old and new)',
  ],
  lastVerified: '2026-02-27',
};
