import type { SiteKnowledge } from '../types.js';

export const amazon: SiteKnowledge = {
  id: 'amazon',
  name: 'Amazon',
  urlPatterns: ['amazon\\.com', 'amazon\\.co\\.', 'amazon\\.in'],
  baseUrl: 'https://www.amazon.com',
  selectors: {
    searchBox: {
      primary: 'input#twotabsearchtextbox',
      fallbacks: ['input[name="field-keywords"]', '#nav-search input[type="text"]'],
      description: 'Main search input',
    },
    searchButton: {
      primary: 'input#nav-search-submit-button',
      fallbacks: ['input.nav-input[type="submit"]', '#nav-search-submit-button'],
      description: 'Search submit button',
    },
    firstResult: {
      primary: 'div[data-component-type="s-search-result"]:first-of-type h2 a',
      fallbacks: ['.s-main-slot .s-result-item:first-child h2 a', '.s-search-results .s-result-item h2 a'],
      description: 'First search result product link',
    },
    productTitle: {
      primary: '#productTitle',
      fallbacks: ['span#productTitle', '#title_feature_div #productTitle'],
      description: 'Product title on detail page',
    },
    productPrice: {
      primary: '.a-price .a-offscreen',
      fallbacks: ['#priceblock_ourprice', '#priceblock_dealprice', 'span.a-price-whole'],
      description: 'Product price',
    },
    addToCart: {
      primary: '#add-to-cart-button',
      fallbacks: ['input#add-to-cart-button', 'button#add-to-cart-button'],
      description: 'Add to Cart button',
    },
    buyNow: {
      primary: '#buy-now-button',
      fallbacks: ['input#buy-now-button', 'button#buy-now-button'],
      description: 'Buy Now button',
    },
    rating: {
      primary: '#acrPopover .a-icon-alt',
      fallbacks: ['span[data-hook="rating-out-of-text"]', '.a-icon-star-small .a-icon-alt'],
      description: 'Product star rating',
    },
    reviewCount: {
      primary: '#acrCustomerReviewText',
      fallbacks: ['[data-hook="total-review-count"]', 'span#acrCustomerReviewText'],
      description: 'Number of reviews',
    },
    cartCount: {
      primary: '#nav-cart-count',
      fallbacks: ['span.nav-cart-count', '#nav-cart-count-container span'],
      description: 'Cart item count badge',
    },
  },
  actions: [
    {
      name: 'search_products',
      steps: [
        'browser_navigate to https://www.amazon.com/s?k=URL_ENCODED_QUERY',
        'Wait 2 seconds for results',
        'browser_screenshot to see products',
        'Each result is a div[data-component-type="s-search-result"]',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
      tips: ['Direct URL search is fastest: amazon.com/s?k=search+terms'],
    },
    {
      name: 'view_product',
      steps: [
        'browser_navigate to the product URL (amazon.com/dp/ASIN)',
        'Wait 2 seconds for page to load',
        'browser_screenshot to see product details, price, rating',
      ],
      tools: ['browser_navigate', 'browser_screenshot'],
    },
    {
      name: 'add_to_cart',
      steps: [
        'Navigate to product page',
        'browser_click on "#add-to-cart-button"',
        'Wait 1 second for confirmation',
        'browser_screenshot to verify item was added',
      ],
      tools: ['browser_navigate', 'browser_click', 'browser_screenshot'],
    },
  ],
  tips: [
    'Direct product URL: amazon.com/dp/ASIN (10-char product ID)',
    'Direct search URL: amazon.com/s?k=search+terms',
    'Filter by category: amazon.com/s?k=query&i=electronics',
    'Price is often in .a-price .a-offscreen (screen reader text has full price)',
    'Product images are in #imageBlock or #altImages',
  ],
  gotchas: [
    'Amazon may show CAPTCHA for automated access — slow down between pages',
    'Prices vary by location — Amazon uses geo-detection',
    'Some products have multiple sellers — "Add to Cart" may default to non-Amazon seller',
    'Login required for: checkout, wishlists, order history',
    'Country redirects: amazon.com may redirect to amazon.co.uk, amazon.in based on IP',
  ],
  lastVerified: '2026-02-27',
};
