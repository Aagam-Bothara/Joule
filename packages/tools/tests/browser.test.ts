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
  evaluate: vi.fn().mockResolvedValue([]),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  waitForTimeout: vi.fn().mockResolvedValue(undefined),
  hover: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn().mockResolvedValue(undefined),
  selectOption: vi.fn().mockResolvedValue(undefined),
  mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
  accessibility: { snapshot: vi.fn().mockResolvedValue({ role: 'WebArea', name: 'Test Page', children: [] }) },
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
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
  browserSnapshotTool,
  browserActTool,
  closeBrowser,
} from '../src/builtin/browser.js';

describe('Browser Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock queues (clearAllMocks doesn't clear mockResolvedValueOnce queue)
    mockPage.evaluate.mockReset().mockResolvedValue([]);
    mockPage.goto.mockReset().mockResolvedValue(undefined);
    mockPage.title.mockReset().mockResolvedValue('Test Page');
    mockPage.url.mockReset().mockReturnValue('https://example.com');
    mockPage.innerText.mockReset().mockResolvedValue('Page body content');
    mockPage.screenshot.mockReset().mockResolvedValue(Buffer.from('png-data'));
    mockPage.$.mockReset();
    mockPage.$$.mockReset().mockResolvedValue([]);
    mockPage.click.mockReset().mockResolvedValue(undefined);
    mockPage.fill.mockReset().mockResolvedValue(undefined);
    mockPage.press.mockReset().mockResolvedValue(undefined);
    mockPage.waitForSelector.mockReset().mockResolvedValue(undefined);
    mockPage.waitForLoadState.mockReset().mockResolvedValue(undefined);
    mockPage.waitForTimeout.mockReset().mockResolvedValue(undefined);
    mockPage.hover.mockReset().mockResolvedValue(undefined);
    mockPage.focus.mockReset().mockResolvedValue(undefined);
    mockPage.selectOption.mockReset().mockResolvedValue(undefined);
    mockPage.mouse.wheel.mockReset().mockResolvedValue(undefined);
    mockPage.accessibility.snapshot.mockReset().mockResolvedValue({ role: 'WebArea', name: 'Test Page', children: [] });
    mockPage.viewportSize.mockReset().mockReturnValue({ width: 1280, height: 720 });
    mockBrowser.newPage.mockReset().mockResolvedValue(mockPage);
    mockBrowser.close.mockReset().mockResolvedValue(undefined);
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
      mockPage.evaluate.mockResolvedValueOnce({ key: 'value' });

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

  // --- Layered Page Intelligence tests ---

  describe('browser_snapshot', () => {
    const mockElements = [
      {
        index: 0, tag: 'button', text: 'Submit', selector: '#submit-btn',
        role: 'button', ariaLabel: 'Submit form', placeholder: undefined, type: undefined,
        state: { visible: true, disabled: false, checked: undefined, selected: undefined, focused: false },
        bbox: { x: 100, y: 200, width: 80, height: 30 },
      },
      {
        index: 1, tag: 'input', text: '', selector: "input[name='email']",
        role: undefined, ariaLabel: undefined, placeholder: 'Enter email', type: 'email',
        state: { visible: true, disabled: false, checked: undefined, selected: undefined, focused: true },
        bbox: { x: 100, y: 150, width: 200, height: 30 },
      },
    ];

    const mockForms = [
      { action: 'https://example.com/login', method: 'POST', inputs: ['email (email)', 'password (password)'] },
    ];

    it('should return indexed elements at level 0', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserSnapshotTool.execute({ level: 0 });

      expect(result.title).toBe('Test Page');
      expect(result.url).toBe('https://example.com');
      expect(result.elements).toHaveLength(2);
      expect(result.elements[0].tag).toBe('button');
      expect(result.elements[0].selector).toBe('#submit-btn');
      expect(result.elements[0].state.visible).toBe(true);
      expect(result.elements[0].bbox.x).toBe(100);
      expect(result.elements[1].state.focused).toBe(true);
      expect(result.focusedElement).toBe(1);
      expect(result.forms).toHaveLength(1);
      expect(result.totalElements).toBe(2);
      expect(result.energyMWh).toBeGreaterThan(0);
      // Level 0 should not have accessibility tree or wireframe
      expect(result.accessibilityTree).toBeUndefined();
      expect(result.wireframe).toBeUndefined();
    });

    it('should include accessibility tree at level 1', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserSnapshotTool.execute({ level: 1 });

      expect(result.accessibilityTree).toBeDefined();
      expect(result.accessibilityTree).toContain('WebArea');
      expect(result.wireframe).toBeUndefined();
    });

    it('should include ASCII wireframe at level 2', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserSnapshotTool.execute({ level: 2 });

      expect(result.accessibilityTree).toBeDefined();
      expect(result.wireframe).toBeDefined();
      expect(result.wireframe).toContain('[0]');
    });

    it('should take element screenshot at level 3', async () => {
      const mockHandle = { screenshot: vi.fn().mockResolvedValue(Buffer.from('el-png')) };
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);
      mockPage.$.mockResolvedValueOnce(mockHandle);

      const result = await browserSnapshotTool.execute({ level: 3, screenshotElement: 0 });

      expect(result.elementScreenshotPath).toBeDefined();
      expect(result.elementScreenshotPath).toContain('element-0');
      expect(mockHandle.screenshot).toHaveBeenCalled();
    });

    it('should take full page screenshot at level 4', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserSnapshotTool.execute({ level: 4 });

      expect(result.fullScreenshotPath).toBeDefined();
      expect(result.fullScreenshotPath).toContain('snapshot-full');
      expect(mockPage.screenshot).toHaveBeenCalled();
    });

    it('should compute delta on second snapshot', async () => {
      // First snapshot (ensureBrowser creates new browser — no evaluate('1') health check)
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);
      await browserSnapshotTool.execute({ level: 0 });

      // Second snapshot with a new element
      // Note: ensureBrowser() calls evaluate('1') to health-check the existing page
      const newElements = [
        ...mockElements,
        {
          index: 2, tag: 'a', text: 'Click here', selector: 'a.new-link',
          role: undefined, ariaLabel: undefined, placeholder: undefined, type: undefined,
          state: { visible: true, disabled: false, checked: undefined, selected: undefined, focused: false },
          bbox: { x: 50, y: 300, width: 100, height: 20 },
        },
      ];
      mockPage.evaluate
        .mockResolvedValueOnce('1')        // ensureBrowser health check
        .mockResolvedValueOnce(newElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserSnapshotTool.execute({ level: 0 });

      expect(result.delta).toBeDefined();
      expect(result.delta!.added).toContain(2);
      expect(result.delta!.removed).toHaveLength(0);
    });

    it('should handle empty pages', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await browserSnapshotTool.execute({});

      expect(result.elements).toHaveLength(0);
      expect(result.totalElements).toBe(0);
      expect(result.focusedElement).toBeNull();
    });
  });

  describe('browser_act', () => {
    const mockElements = [
      {
        index: 0, tag: 'button', text: 'Submit', selector: '#submit-btn',
        role: 'button', ariaLabel: 'Submit form', placeholder: undefined, type: undefined,
        state: { visible: true, disabled: false, checked: undefined, selected: undefined, focused: false },
        bbox: { x: 100, y: 200, width: 80, height: 30 },
      },
      {
        index: 1, tag: 'input', text: '', selector: "input[name='email']",
        role: undefined, ariaLabel: undefined, placeholder: 'Enter email', type: 'email',
        state: { visible: true, disabled: false, checked: undefined, selected: undefined, focused: true },
        bbox: { x: 100, y: 150, width: 200, height: 30 },
      },
    ];

    const mockForms = [{ action: '', method: 'GET', inputs: [] }];

    beforeEach(async () => {
      // Prime the element registry with a snapshot
      mockPage.evaluate
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);
      await browserSnapshotTool.execute({ level: 0 });
    });

    it('should click element by index', async () => {
      // Mock: ensureBrowser health check + post-action extraction
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'click', element: 0 });

      expect(result.success).toBe(true);
      expect(result.action).toBe('click');
      expect(result.elementDescription).toContain('[0]');
      expect(result.elementDescription).toContain('button');
      expect(mockPage.click).toHaveBeenCalledWith('#submit-btn');
    });

    it('should type text into element by index', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'type', element: 1, text: 'test@example.com' });

      expect(result.success).toBe(true);
      expect(mockPage.fill).toHaveBeenCalledWith("input[name='email']", 'test@example.com');
    });

    it('should type and submit when submit is true', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      await browserActTool.execute({ action: 'type', element: 1, text: 'query', submit: true });

      expect(mockPage.fill).toHaveBeenCalledWith("input[name='email']", 'query');
      expect(mockPage.press).toHaveBeenCalledWith("input[name='email']", 'Enter');
    });

    it('should hover over element by index', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'hover', element: 0 });

      expect(result.success).toBe(true);
      expect(mockPage.hover).toHaveBeenCalledWith('#submit-btn');
    });

    it('should focus element by index', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'focus', element: 1 });

      expect(result.success).toBe(true);
      expect(mockPage.focus).toHaveBeenCalledWith("input[name='email']");
    });

    it('should clear element by index', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'clear', element: 1 });

      expect(result.success).toBe(true);
      expect(mockPage.fill).toHaveBeenCalledWith("input[name='email']", '');
    });

    it('should select option by index', async () => {
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'select', element: 0, text: 'option1' });

      expect(result.success).toBe(true);
      expect(mockPage.selectOption).toHaveBeenCalledWith('#submit-btn', 'option1');
    });

    it('should scroll element by index', async () => {
      const mockHandle = { scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined) };
      mockPage.$.mockResolvedValueOnce(mockHandle);
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'scroll', element: 0, direction: 'down', amount: 500 });

      expect(result.success).toBe(true);
      expect(mockHandle.scrollIntoViewIfNeeded).toHaveBeenCalled();
      expect(mockPage.mouse.wheel).toHaveBeenCalledWith(0, 500);
    });

    it('should throw when element index not found', async () => {
      await expect(
        browserActTool.execute({ action: 'click', element: 99 })
      ).rejects.toThrow('Element [99] not found');
    });

    it('should throw when type action has no text', async () => {
      await expect(
        browserActTool.execute({ action: 'type', element: 0 })
      ).rejects.toThrow('text is required');
    });

    it('should return delta showing URL change', async () => {
      // After action, URL changes
      mockPage.title.mockResolvedValueOnce('New Page');
      mockPage.url.mockReturnValueOnce('https://example.com/new');
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(mockElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'click', element: 0 });

      expect(result.delta.urlChanged).toBe(true);
      expect(result.delta.newUrl).toBe('https://example.com/new');
      expect(result.delta.titleChanged).toBe(true);
      expect(result.delta.newTitle).toBe('New Page');
    });

    it('should return delta with added elements', async () => {
      const newElements = [
        ...mockElements,
        {
          index: 2, tag: 'div', text: 'Modal', selector: '#modal',
          role: 'dialog', ariaLabel: undefined, placeholder: undefined, type: undefined,
          state: { visible: true, disabled: false, checked: undefined, selected: undefined, focused: false },
          bbox: { x: 200, y: 100, width: 400, height: 300 },
        },
      ];
      mockPage.evaluate
        .mockResolvedValueOnce('1')
        .mockResolvedValueOnce(newElements)
        .mockResolvedValueOnce(mockForms);

      const result = await browserActTool.execute({ action: 'click', element: 0 });

      expect(result.delta.added).toHaveLength(1);
      expect(result.delta.added[0].tag).toBe('div');
      expect(result.delta.added[0].text).toBe('Modal');
    });
  });
});
