import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Playwright before importing browser tools
const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  title: vi.fn().mockResolvedValue('Test Page'),
  url: vi.fn().mockReturnValue('https://example.com'),
  innerText: vi.fn().mockResolvedValue('Page body content'),
  screenshot: vi.fn().mockResolvedValue(Buffer.from('png-data')),
  $: vi.fn(),
  $$: vi.fn().mockResolvedValue([]),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  press: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue({ key: 'value' }),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserWaitAndClickTool,
  browserTypeTool,
  browserExtractTool,
  browserObserveTool,
  browserEvaluateTool,
  closeBrowser,
} from '../src/builtin/browser.js';

describe('Browser Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await closeBrowser();
  });

  describe('browser_navigate', () => {
    it('should navigate to a URL and return page info', async () => {
      const result = await browserNavigateTool.execute({ url: 'https://example.com' });

      expect(result.title).toBe('Test Page');
      expect(result.url).toBe('https://example.com');
      expect(result.content).toBe('Page body content');
      expect(result.energyMWh).toBeGreaterThan(0);
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'load' });
    });

    it('should support custom waitFor option', async () => {
      await browserNavigateTool.execute({ url: 'https://example.com', waitFor: 'networkidle' });
      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'networkidle' });
    });
  });

  describe('browser_screenshot', () => {
    it('should take a full page screenshot', async () => {
      const result = await browserScreenshotTool.execute({ fullPage: true });

      expect(result.filePath).toMatch(/screenshot-\d+\.png$/);
      expect(result.energyMWh).toBeGreaterThan(0);
      expect(mockPage.screenshot).toHaveBeenCalled();
    });

    it('should take an element screenshot when selector provided', async () => {
      const mockElement = { screenshot: vi.fn().mockResolvedValue(Buffer.from('el-png')) };
      mockPage.$.mockResolvedValueOnce(mockElement);

      const result = await browserScreenshotTool.execute({ selector: '#hero' });

      expect(result.filePath).toMatch(/screenshot-\d+\.png$/);
      expect(mockPage.$).toHaveBeenCalledWith('#hero');
      expect(mockElement.screenshot).toHaveBeenCalled();
    });

    it('should throw if selector element not found', async () => {
      mockPage.$.mockResolvedValueOnce(null);

      await expect(
        browserScreenshotTool.execute({ selector: '#nonexistent' })
      ).rejects.toThrow('Element not found: #nonexistent');
    });
  });

  describe('browser_click', () => {
    it('should click an element by selector', async () => {
      const result = await browserClickTool.execute({ selector: 'button.submit' });

      expect(result.success).toBe(true);
      expect(result.energyMWh).toBeGreaterThan(0);
      expect(mockPage.click).toHaveBeenCalledWith('button.submit');
    });
  });

  describe('browser_wait_and_click', () => {
    it('should wait for and click element when it appears', async () => {
      mockPage.waitForSelector.mockResolvedValueOnce(undefined);
      mockPage.click.mockResolvedValueOnce(undefined);

      const result = await browserWaitAndClickTool.execute({
        selector: 'button.ytp-skip-ad-button',
        timeoutMs: 5000,
      });

      expect(result.clicked).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.waitedMs).toBeGreaterThanOrEqual(0);
      expect(result.energyMWh).toBeGreaterThan(0);
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('button.ytp-skip-ad-button', { timeout: 5000, state: 'visible' });
      expect(mockPage.click).toHaveBeenCalledWith('button.ytp-skip-ad-button');
    });

    it('should return timedOut when element never appears', async () => {
      mockPage.waitForSelector.mockRejectedValueOnce(new Error('Timeout exceeded'));

      const result = await browserWaitAndClickTool.execute({
        selector: '.nonexistent',
        timeoutMs: 100,
      });

      expect(result.clicked).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(mockPage.click).not.toHaveBeenCalled();
    });

    it('should use default timeout when not specified', async () => {
      mockPage.waitForSelector.mockResolvedValueOnce(undefined);

      await browserWaitAndClickTool.execute({
        selector: 'button.skip',
      });

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('button.skip', { timeout: 10000, state: 'visible' });
    });
  });

  describe('browser_type', () => {
    it('should type text into an input', async () => {
      const result = await browserTypeTool.execute({
        selector: '#search',
        text: 'hello world',
      });

      expect(result.success).toBe(true);
      expect(mockPage.fill).toHaveBeenCalledWith('#search', 'hello world');
      expect(mockPage.press).not.toHaveBeenCalled();
    });

    it('should press Enter when submit is true', async () => {
      await browserTypeTool.execute({
        selector: '#search',
        text: 'query',
        submit: true,
      });

      expect(mockPage.fill).toHaveBeenCalledWith('#search', 'query');
      expect(mockPage.press).toHaveBeenCalledWith('#search', 'Enter');
    });
  });

  describe('browser_extract', () => {
    it('should extract text from matching elements', async () => {
      mockPage.$$.mockResolvedValueOnce([
        { innerText: vi.fn().mockResolvedValue('Item 1'), getAttribute: vi.fn() },
        { innerText: vi.fn().mockResolvedValue('Item 2'), getAttribute: vi.fn() },
      ]);

      const result = await browserExtractTool.execute({ selector: '.item' });

      expect(result.results).toEqual(['Item 1', 'Item 2']);
      expect(result.count).toBe(2);
    });

    it('should extract attributes when specified', async () => {
      mockPage.$$.mockResolvedValueOnce([
        { getAttribute: vi.fn().mockResolvedValue('https://link1.com'), innerText: vi.fn() },
        { getAttribute: vi.fn().mockResolvedValue('https://link2.com'), innerText: vi.fn() },
      ]);

      const result = await browserExtractTool.execute({ selector: 'a', attribute: 'href' });

      expect(result.results).toEqual(['https://link1.com', 'https://link2.com']);
      expect(result.count).toBe(2);
    });
  });

  describe('browser_observe', () => {
    it('should extract interactive elements from the page', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce([
          { index: 0, tag: 'button', text: 'Submit', selector: '#submit-btn', ariaLabel: 'Submit form', visible: true },
          { index: 1, tag: 'input', type: 'text', text: '', selector: "input[name='email']", placeholder: 'Enter email', visible: true },
        ])
        .mockResolvedValueOnce([
          { action: 'https://example.com/login', method: 'POST', inputs: ['email (email)', 'password (password)'] },
        ]);

      const result = await browserObserveTool.execute({ purpose: 'find login form' });

      expect(result.title).toBe('Test Page');
      expect(result.url).toBe('https://example.com');
      expect(result.interactiveElements).toHaveLength(2);
      expect(result.interactiveElements[0].tag).toBe('button');
      expect(result.interactiveElements[0].selector).toBe('#submit-btn');
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0].method).toBe('POST');
      expect(result.energyMWh).toBeGreaterThan(0);
      expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
    });

    it('should handle pages with no interactive elements', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await browserObserveTool.execute({});

      expect(result.interactiveElements).toHaveLength(0);
      expect(result.forms).toHaveLength(0);
      expect(result.totalElements).toBe(0);
    });
  });

  describe('browser_evaluate', () => {
    it('should execute JavaScript and return result', async () => {
      const result = await browserEvaluateTool.execute({
        script: 'document.title',
      });

      expect(result.result).toEqual({ key: 'value' });
      expect(result.energyMWh).toBeGreaterThan(0);
      expect(mockPage.evaluate).toHaveBeenCalledWith('document.title');
    });
  });

  describe('BrowserSession', () => {
    it('should reuse browser across multiple tool calls', async () => {
      const { chromium } = await import('playwright');

      await browserNavigateTool.execute({ url: 'https://example.com' });
      await browserClickTool.execute({ selector: 'button' });

      // chromium.launch should only be called once
      expect(chromium.launch).toHaveBeenCalledTimes(1);
    });
  });
});
