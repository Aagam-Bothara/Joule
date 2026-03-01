import type { SiteKnowledge } from '../types.js';

export const yahoo: SiteKnowledge = {
  id: 'yahoo',
  name: 'Yahoo',
  urlPatterns: ['yahoo\\.com', 'search\\.yahoo\\.com', 'mail\\.yahoo\\.com', 'finance\\.yahoo\\.com', 'news\\.yahoo\\.com'],
  baseUrl: 'https://www.yahoo.com',
  selectors: {
    searchBox: {
      primary: 'input#ybar-sbq',
      fallbacks: ['input[name="p"]', 'input#search-input', 'input[aria-label*="Search"]'],
      description: 'Main search input in Yahoo toolbar',
    },
    searchButton: {
      primary: 'button#ybar-search',
      fallbacks: ['button[type="submit"]', 'input[type="submit"]'],
      description: 'Search submit button',
    },
    searchResult: {
      primary: 'div#web ol li div.algo',
      fallbacks: ['div.searchCenterMiddle li', 'div#results li h3 a'],
      description: 'Individual search result on Yahoo Search',
    },
    newsArticle: {
      primary: 'li.stream-item a.js-content-viewer',
      fallbacks: ['div[data-test-locator="stream-item"]', 'li.js-stream-content a'],
      description: 'News article link in Yahoo News feed',
    },
    mailComposeButton: {
      primary: 'a[data-test-id="compose-button"]',
      fallbacks: ['a[aria-label="Compose"]', 'button[aria-label="Compose"]'],
      description: 'Compose email button in Yahoo Mail',
    },
    financeSearchBox: {
      primary: 'input#yfin-usr-qry',
      fallbacks: ['input[placeholder*="Search for news"]', 'input[placeholder*="Quote Lookup"]'],
      description: 'Finance search/quote lookup input',
    },
    financeQuotePrice: {
      primary: 'fin-streamer[data-field="regularMarketPrice"]',
      fallbacks: ['span[data-reactid*="price"]', 'div#quote-header-info fin-streamer'],
      description: 'Stock price on quote page',
    },
    financeQuoteChange: {
      primary: 'fin-streamer[data-field="regularMarketChange"]',
      fallbacks: ['span[data-reactid*="change"]'],
      description: 'Stock price change on quote page',
    },
    weatherWidget: {
      primary: 'div#Lead-0-WeatherCard',
      fallbacks: ['section[data-test-locator*="weather"]', 'div.weather-card'],
      description: 'Weather widget on Yahoo homepage',
    },
    trendingTopics: {
      primary: 'div#Aside li a',
      fallbacks: ['div.trending-list a', 'ol.lst-16 li a'],
      description: 'Trending topics in sidebar',
    },
  },
  actions: [
    {
      name: 'web_search',
      steps: [
        'browser_navigate to https://search.yahoo.com/search?p=URL_ENCODED_QUERY',
        'Wait 2 seconds for results to load',
        'browser_screenshot to see search results',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Direct search URL is fastest: search.yahoo.com/search?p=query'],
    },
    {
      name: 'check_stock',
      steps: [
        'browser_navigate to https://finance.yahoo.com/quote/TICKER_SYMBOL/',
        'Wait 2 seconds for quote to load',
        'browser_screenshot to see price, change, chart, and key stats',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Direct quote URL: finance.yahoo.com/quote/AAPL/ for Apple stock'],
    },
    {
      name: 'read_news',
      steps: [
        'browser_navigate to https://news.yahoo.com/',
        'Wait 2 seconds for news feed to load',
        'browser_screenshot to see top headlines',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'check_finance_summary',
      steps: [
        'browser_navigate to https://finance.yahoo.com/',
        'Wait 2 seconds for market data to load',
        'browser_screenshot to see market overview (S&P 500, Dow, Nasdaq, etc.)',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
  ],
  tips: [
    'Yahoo is mostly accessible without login (search, news, finance)',
    'Direct search URL: search.yahoo.com/search?p=query',
    'Finance quote: finance.yahoo.com/quote/TICKER/',
    'Finance uses custom web components (fin-streamer) for real-time price data',
    'Yahoo News: news.yahoo.com/',
    'Yahoo Mail requires login: mail.yahoo.com/',
    'Image search: images.search.yahoo.com/search/images?p=query',
    'Yahoo Sports: sports.yahoo.com/',
  ],
  gotchas: [
    'Yahoo shows many ads and sponsored content — real results may be below fold',
    'Yahoo Mail requires login — will redirect to sign-in page',
    'Finance data has slight delay (15-20 min) for free tier — real-time requires subscription',
    'Cookie consent banners may appear and block content — dismiss first',
    'Yahoo may redirect between regional versions based on IP (yahoo.co.jp, yahoo.co.uk)',
    'Some news articles link to external sites — leaving Yahoo domain',
  ],
  lastVerified: '2026-02-27',
};
