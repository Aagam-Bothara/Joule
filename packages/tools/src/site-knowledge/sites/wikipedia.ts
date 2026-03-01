import type { SiteKnowledge } from '../types.js';

export const wikipedia: SiteKnowledge = {
  id: 'wikipedia',
  name: 'Wikipedia',
  urlPatterns: ['wikipedia\\.org', 'en\\.wikipedia\\.org', 'wikimedia\\.org'],
  baseUrl: 'https://en.wikipedia.org',
  selectors: {
    searchBox: {
      primary: 'input#searchInput',
      fallbacks: ['input[name="search"]', 'input#searchform input', 'input[aria-label="Search Wikipedia"]'],
      description: 'Main search input',
    },
    searchButton: {
      primary: 'button.cdx-search-input__end-button',
      fallbacks: ['input#searchButton', 'button[type="submit"]'],
      description: 'Search submit button',
    },
    articleTitle: {
      primary: 'h1#firstHeading',
      fallbacks: ['h1.firstHeading', '#content h1', 'span.mw-page-title-main'],
      description: 'Article title heading',
    },
    articleContent: {
      primary: 'div#mw-content-text .mw-parser-output',
      fallbacks: ['div#bodyContent', 'div.mw-body-content', '#mw-content-text'],
      description: 'Main article content area',
    },
    firstParagraph: {
      primary: 'div#mw-content-text .mw-parser-output > p:not(.mw-empty-elt)',
      fallbacks: ['div.mw-parser-output > p:first-of-type'],
      description: 'First paragraph of the article (intro summary)',
    },
    tableOfContents: {
      primary: 'div#toc',
      fallbacks: ['nav#mw-panel-toc', 'div.toc', 'div[role="navigation"].toc'],
      description: 'Table of contents panel',
    },
    infobox: {
      primary: 'table.infobox',
      fallbacks: ['table.vcard', 'table.biography', 'table.vevent'],
      description: 'Article infobox (right-side summary table)',
    },
    categoryLinks: {
      primary: 'div#mw-normal-catlinks ul li a',
      fallbacks: ['div.mw-normal-catlinks a', '#catlinks a'],
      description: 'Category links at bottom of article',
    },
    editButton: {
      primary: 'a#ca-edit',
      fallbacks: ['li#ca-edit a', 'span.mw-editsection a'],
      description: 'Edit article button',
    },
    languageSelector: {
      primary: 'button#p-lang-btn',
      fallbacks: ['div#p-lang', 'a.interlanguage-link'],
      description: 'Language switcher for article translations',
    },
  },
  actions: [
    {
      name: 'search',
      steps: [
        'browser_navigate to https://en.wikipedia.org/w/index.php?search=URL_ENCODED_QUERY',
        'Wait 1 second for results',
        'browser_screenshot to see search results or direct article',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Wikipedia may redirect directly to an article if the search matches exactly'],
    },
    {
      name: 'read_article',
      steps: [
        'browser_navigate to https://en.wikipedia.org/wiki/ARTICLE_TITLE',
        'Wait 1 second for article to load',
        'browser_screenshot to read the article intro and infobox',
        'Scroll down and take more screenshots to read more sections',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Article titles use underscores for spaces: /wiki/United_States'],
    },
    {
      name: 'read_section',
      steps: [
        'browser_navigate to https://en.wikipedia.org/wiki/ARTICLE_TITLE#SECTION_ID',
        'Wait 1 second',
        'browser_screenshot to read the specific section',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Section IDs match heading text with underscores: #History, #Early_life'],
    },
    {
      name: 'extract_article_text',
      steps: [
        'browser_navigate to the article URL',
        'browser_extract with selector "div#mw-content-text .mw-parser-output" to get full text',
      ],
      tools: ['browser_navigate', 'browser_extract'],
      tips: ['Use browser_extract for text-heavy reading — more efficient than screenshots'],
    },
  ],
  tips: [
    'Wikipedia is fully accessible without login',
    'Direct article URL: en.wikipedia.org/wiki/Article_Title (underscores for spaces)',
    'Search URL: en.wikipedia.org/w/index.php?search=query',
    'Random article: en.wikipedia.org/wiki/Special:Random',
    'Wikipedia has a very stable, semantic DOM — selectors rarely change',
    'Articles have clear structure: #firstHeading, .mw-parser-output, table.infobox',
    'Use browser_extract instead of screenshots for text-heavy content — Wikipedia is text-rich',
    'Other languages: replace "en" with language code (es, fr, de, ja, etc.)',
    'Mobile version: en.m.wikipedia.org/wiki/Article_Title',
  ],
  gotchas: [
    'Article titles are case-sensitive (first letter is auto-capitalized)',
    'Some articles have disambiguation pages — check if redirected',
    'Very long articles may require multiple scroll+screenshot cycles',
    'Tables and infoboxes have complex nested HTML — extract text rather than parse HTML',
    'Some articles are semi-protected — editing requires login',
    'Media files (images, videos) are hosted on commons.wikimedia.org',
  ],
  lastVerified: '2026-02-27',
};
