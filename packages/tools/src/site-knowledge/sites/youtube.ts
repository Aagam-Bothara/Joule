import type { SiteKnowledge } from '../types.js';

export const youtube: SiteKnowledge = {
  id: 'youtube',
  name: 'YouTube',
  urlPatterns: ['youtube\\.com', 'youtu\\.be'],
  baseUrl: 'https://www.youtube.com',
  selectors: {
    searchBox: {
      primary: 'input#search',
      fallbacks: ['input[name="search_query"]', 'ytd-searchbox input'],
      description: 'Main search input field',
    },
    searchButton: {
      primary: 'button#search-icon-legacy',
      fallbacks: ['button[aria-label="Search"]', 'ytd-searchbox button'],
      description: 'Search submit button',
    },
    firstVideoResult: {
      primary: 'ytd-video-renderer a#video-title',
      fallbacks: ['a.ytd-video-renderer', 'ytd-video-renderer h3 a', '#contents ytd-video-renderer:first-child a#video-title'],
      description: 'First video result link in search results',
    },
    videoPlayer: {
      primary: '#movie_player video',
      fallbacks: ['video.html5-main-video', '#player video', '.html5-video-container video'],
      description: 'The video player element',
    },
    playButton: {
      primary: 'button.ytp-play-button',
      fallbacks: ['[aria-label="Play"]', '.ytp-play-button'],
      description: 'Play/pause button on video player',
    },
    videoTitle: {
      primary: 'yt-formatted-string.ytd-watch-metadata',
      fallbacks: ['h1.ytd-watch-metadata yt-formatted-string', '#title h1', 'ytd-video-primary-info-renderer h1'],
      description: 'Current video title',
    },
    subscribeButton: {
      primary: '#subscribe-button button',
      fallbacks: ['ytd-subscribe-button-renderer button', 'tp-yt-paper-button#button'],
      description: 'Subscribe button on channel/video page',
    },
    likeButton: {
      primary: 'ytd-menu-renderer like-button-view-model button',
      fallbacks: ['#segmented-like-button button', 'button[aria-label*="like"]'],
      description: 'Like button on video',
    },
  },
  actions: [
    {
      name: 'search_and_play',
      steps: [
        'browser_navigate to https://www.youtube.com',
        'browser_type into "input#search" with the search query, then press Enter (add \\n to text)',
        'Wait 2 seconds for results to load (browser_screenshot to verify)',
        'browser_click on "ytd-video-renderer a#video-title" to click the first result',
        'Wait 2 seconds for video to start, then browser_screenshot to confirm',
      ],
      tools: ['browser_navigate', 'browser_type', 'browser_click', 'browser_screenshot'],
      tips: [
        'Append \\n to the search text to auto-submit instead of clicking the search button',
        'YouTube search results load dynamically — wait 2 seconds after searching',
        'Videos auto-play by default, no need to click the play button',
      ],
    },
    {
      name: 'play_specific_video',
      steps: [
        'browser_navigate directly to the video URL (https://www.youtube.com/watch?v=VIDEO_ID)',
        'Video will auto-play. Take browser_screenshot to confirm.',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
  ],
  tips: [
    'YouTube videos auto-play when you navigate to them — no need to click play',
    'Search results are rendered as <ytd-video-renderer> custom elements',
    'The site uses shadow DOM in some areas — prefer top-level selectors',
    'Cookie consent banner may appear on first visit — look for "Accept all" button',
    'Use \\n at end of search text to submit instead of finding the search button',
  ],
  gotchas: [
    'Cookie consent popup: click button with text "Accept all" or "Reject all" if it appears',
    'Age-restricted videos require sign-in — cannot be played without authentication',
    'Ads may play before the video — wait for them or look for "Skip Ad" button (button.ytp-skip-ad-button)',
    'YouTube layout changes frequently — if primary selectors fail, use fallbacks',
  ],
  lastVerified: '2026-02-27',
};
