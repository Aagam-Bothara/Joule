import type { SiteKnowledge } from '../types.js';

export const twitter: SiteKnowledge = {
  id: 'twitter',
  name: 'X (Twitter)',
  urlPatterns: ['x\\.com', 'twitter\\.com'],
  baseUrl: 'https://x.com',
  selectors: {
    searchBox: {
      primary: 'input[data-testid="SearchBox_Search_Input"]',
      fallbacks: ['input[aria-label="Search query"]', 'input[placeholder="Search"]'],
      description: 'Search input field',
    },
    tweetCompose: {
      primary: 'div[data-testid="tweetTextarea_0"]',
      fallbacks: ['div[role="textbox"][data-testid*="tweetTextarea"]', 'div.public-DraftEditor-content'],
      description: 'Tweet compose text area',
    },
    tweetButton: {
      primary: 'button[data-testid="tweetButtonInline"]',
      fallbacks: ['div[data-testid="tweetButton"]', 'button[data-testid="tweetButton"]'],
      description: 'Post/tweet button',
    },
    firstTweet: {
      primary: 'article[data-testid="tweet"]:first-of-type',
      fallbacks: ['div[data-testid="cellInnerDiv"]:first-child article', '[data-testid="tweet"]'],
      description: 'First tweet in timeline',
    },
    likeButton: {
      primary: 'button[data-testid="like"]',
      fallbacks: ['div[data-testid="like"]', '[role="button"][data-testid="like"]'],
      description: 'Like button on a tweet',
    },
    retweetButton: {
      primary: 'button[data-testid="retweet"]',
      fallbacks: ['div[data-testid="retweet"]'],
      description: 'Retweet button on a tweet',
    },
    replyButton: {
      primary: 'button[data-testid="reply"]',
      fallbacks: ['div[data-testid="reply"]'],
      description: 'Reply button on a tweet',
    },
    followButton: {
      primary: 'button[data-testid*="follow"]',
      fallbacks: ['div[data-testid*="follow"] button'],
      description: 'Follow/unfollow button on profile',
    },
    profileName: {
      primary: 'div[data-testid="UserName"]',
      fallbacks: ['[data-testid="UserName"] span'],
      description: 'User profile name',
    },
    trendingSection: {
      primary: '[aria-label="Timeline: Trending now"]',
      fallbacks: ['section[aria-labelledby*="trending"]', '[data-testid="trend"]'],
      description: 'Trending topics section',
    },
  },
  actions: [
    {
      name: 'search',
      steps: [
        'browser_navigate to https://x.com/search?q=URL_ENCODED_QUERY',
        'Wait 2 seconds for results, then browser_screenshot',
        'Tweets are in article[data-testid="tweet"] elements',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Direct URL search is fastest — x.com/search?q=your+query'],
    },
    {
      name: 'post_tweet',
      steps: [
        'browser_navigate to https://x.com/compose/post (or x.com/home)',
        'browser_click on div[data-testid="tweetTextarea_0"]',
        'browser_type the tweet content',
        'browser_click on button[data-testid="tweetButtonInline"] to post',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot'],
    },
    {
      name: 'view_profile',
      steps: [
        'browser_navigate to https://x.com/USERNAME',
        'browser_screenshot to see profile and recent tweets',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
  ],
  tips: [
    'X uses data-testid attributes extensively — prefer these as selectors',
    'Tweet compose box is a contenteditable div, not a textarea',
    'Use direct URLs: x.com/search?q=query, x.com/USERNAME, x.com/USERNAME/status/ID',
    'Most interactive elements have data-testid attributes for reliable selection',
    'Timeline loads dynamically — use browser_screenshot after waiting 2 seconds',
  ],
  gotchas: [
    'Must be logged in for: posting, liking, following, viewing some content',
    'X uses x.com now (not twitter.com) — though twitter.com redirects',
    'Content loads via infinite scroll — only first ~10 tweets visible initially',
    'Login wall may appear for non-authenticated users on some pages',
    'Rate limiting on interactions — don\'t spam likes/retweets',
  ],
  lastVerified: '2026-02-27',
};
