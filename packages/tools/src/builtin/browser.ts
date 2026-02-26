import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import { join } from 'node:path';

// Lazy-loaded Playwright — no static type import to avoid build errors when not installed
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pw: any = null;

async function getPlaywright(): Promise<any> {
  if (!pw) {
    // Use variable to prevent TypeScript from resolving the module at compile time
    const mod = 'playwright';
    pw = await import(/* @vite-ignore */ mod);
  }
  return pw;
}

interface BrowserSessionState {
  browser: any;
  context: any;
  page: any;
  idleTimer: ReturnType<typeof setTimeout> | null;
  idleTimeoutMs: number;
  headless: boolean;
  screenshotDir: string;
  userDataDir: string | null;
  channel: string | null;
  profileDirectory: string | null;
  /** True when we attached to an existing Chrome — don't kill it on close. */
  attachedToExisting: boolean;
}

const session: BrowserSessionState = {
  browser: null,
  context: null,
  page: null,
  idleTimer: null,
  idleTimeoutMs: 300_000, // 5 min
  headless: true,
  screenshotDir: '.joule/screenshots',
  userDataDir: null,
  channel: null,
  profileDirectory: null,
  attachedToExisting: false,
};

// --- Layered Page Intelligence: internal state ---

interface RegisteredElement {
  selector: string;
  tag: string;
  text: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  type?: string;
  state: { visible: boolean; disabled: boolean; checked?: boolean; selected?: boolean; focused: boolean };
  bbox: { x: number; y: number; width: number; height: number };
}

interface SnapshotState {
  url: string;
  title: string;
  elements: Map<number, RegisteredElement>;
  selectorToIndex: Map<string, number>;
  timestamp: number;
}

let elementRegistry: Map<number, RegisteredElement> = new Map();
let previousSnapshot: SnapshotState | null = null;

export function configureBrowser(config?: {
  headless?: boolean;
  screenshotDir?: string;
  idleTimeoutMs?: number;
  userDataDir?: string;
  channel?: string;
  profileDirectory?: string;
}): void {
  if (config?.headless !== undefined) session.headless = config.headless;
  if (config?.screenshotDir) session.screenshotDir = config.screenshotDir;
  if (config?.idleTimeoutMs) session.idleTimeoutMs = config.idleTimeoutMs;
  if (config?.userDataDir) session.userDataDir = config.userDataDir;
  if (config?.channel) session.channel = config.channel;
  if (config?.profileDirectory) session.profileDirectory = config.profileDirectory;
}

/**
 * Detect the default Chrome user data directory based on the platform.
 */
function detectChromeUserDataDir(): string | null {
  const platform = typeof process !== 'undefined' ? process.platform : '';
  const home = typeof process !== 'undefined' ? (process.env.LOCALAPPDATA || process.env.HOME || '') : '';

  if (platform === 'win32') {
    return join(home || `${process.env.USERPROFILE}\\AppData\\Local`, 'Google', 'Chrome', 'User Data');
  } else if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  } else if (platform === 'linux') {
    return join(home, '.config', 'google-chrome');
  }
  return null;
}

/**
 * Find the Chrome executable on this platform.
 */
function findChromeExecutable(): string | null {
  const { existsSync } = fsSync;

  const chromePaths = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];

  for (const p of chromePaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Check if a CDP debug server is already listening on the given port.
 */
async function isCdpPortOpen(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Connect to Chrome via CDP (Chrome DevTools Protocol).
 *
 * Smart connection strategy (inspired by OpenClaw / Playwright MCP):
 *
 * 1. **Attach to existing debug port** — if Chrome is already running with
 *    --remote-debugging-port, connect without disruption.
 *
 * 2. **Launch alongside existing Chrome** — if the user's Chrome is open but
 *    WITHOUT a debug port, we launch a SECOND Chrome instance using a
 *    separate temporary user-data-dir. This avoids the Chrome single-instance
 *    lock problem without killing the user's browser.
 *
 * 3. **Always open a NEW tab** — agent work happens in a fresh tab, never
 *    hijacking the user's existing tabs.
 *
 * On cleanup we only disconnect the Playwright CDP session — we never
 * terminate Chrome processes we didn't launch.
 */
async function connectChromeViaCDP(playwright: any, userDataDir: string): Promise<{ browser: any; page: any; attached: boolean }> {
  const debugPort = 9222;

  // ── Strategy 1: attach to an existing debug port ──────────────────────
  if (await isCdpPortOpen(debugPort)) {
    if (process.env.JOULE_DEBUG) {
      console.error(`[debug] Found existing Chrome debug server on port ${debugPort} — attaching`);
    }

    const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0] || await browser.newContext();
    // Always open a fresh tab so we don't hijack the user's active page
    const page = await context.newPage();

    if (process.env.JOULE_DEBUG) {
      console.error(`[debug] Attached to existing Chrome, opened new tab`);
    }

    return { browser, page, attached: true };
  }

  // ── Strategy 2: launch Chrome with CDP alongside the user's browser ───
  const chromePath = findChromeExecutable();
  if (!chromePath) throw new Error('Chrome executable not found');

  const { spawn } = await import('node:child_process');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');

  // Launch Chrome with a temporary user-data-dir so we don't conflict
  // with the user's already-running Chrome (no single-instance lock issue).
  // This means no login sessions in the agent's browser, but the user's
  // Chrome stays completely untouched.
  const tempDir = mkdtempSync(path.join(tmpdir(), 'joule-chrome-'));

  if (process.env.JOULE_DEBUG) {
    console.error(`[debug] Launching Chrome: ${chromePath}`);
    console.error(`[debug] Temp user data dir: ${tempDir}`);
  }

  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${tempDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
  ];

  const chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  chromeProcess.unref();

  // Wait for debug port to become available
  let started = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await isCdpPortOpen(debugPort)) { started = true; break; }
  }

  if (started) {
    const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = await context.newPage();

    if (process.env.JOULE_DEBUG) {
      console.error(`[debug] Launched Chrome with CDP on port ${debugPort}, opened new tab`);
    }

    return { browser, page, attached: false };
  }

  throw new Error(`Chrome did not start debugging server on port ${debugPort} within 15s`);
}

async function ensureBrowser(): Promise<{ browser: any; page: any }> {
  resetIdleTimer();

  if (session.browser && session.page) {
    // Verify the page is still alive — CDP connections can drop
    try {
      await session.page.evaluate('1');
    } catch {
      // Page/browser is dead — reset and reconnect
      session.browser = null;
      session.context = null;
      session.page = null;
    }
  }

  if (session.browser && session.page) {
    return { browser: session.browser, page: session.page };
  }

  const playwright = await getPlaywright();

  // Strategy 1: CDP — connect to existing Chrome or launch alongside it
  // This preserves all user sessions (Gmail, Discord, YouTube, etc.)
  // and NEVER kills the user's running browser.
  const userDataDir = session.userDataDir || detectChromeUserDataDir();
  if (userDataDir) {
    try {
      const result = await connectChromeViaCDP(playwright, userDataDir);
      session.browser = result.browser;
      session.page = result.page;
      session.attachedToExisting = result.attached;
      if (process.env.JOULE_DEBUG) {
        console.error(`[debug] Chrome CDP ready (attached: ${result.attached})`);
      }
      return result;
    } catch (err) {
      if (process.env.JOULE_DEBUG) {
        console.error('[debug] CDP connection failed:', (err as Error).message);
        console.error('[debug] Falling back to regular browser launch');
      }
    }
  }

  // Strategy 2: Regular Playwright launch (no user profile)
  try {
    session.browser = await playwright.chromium.launch({
      headless: session.headless,
      channel: 'chrome',
    });
  } catch {
    session.browser = await playwright.chromium.launch({ headless: session.headless });
  }
  session.page = await session.browser.newPage();
  return { browser: session.browser, page: session.page };
}

function resetIdleTimer(): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
  }
  session.idleTimer = setTimeout(async () => {
    await closeBrowser();
  }, session.idleTimeoutMs);
}

export async function closeBrowser(): Promise<void> {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  // Close the agent's tab — but leave the browser open if we attached
  // to the user's existing Chrome via CDP.
  if (session.page) {
    try {
      await session.page.close();
    } catch { /* page may already be closed */ }
    session.page = null;
  }

  if (session.browser) {
    try {
      if (session.attachedToExisting) {
        // We attached to the user's browser — just disconnect Playwright,
        // do NOT close or kill Chrome.
        await session.browser.close();
      } else {
        // We launched this browser — safe to close it fully.
        await session.browser.close();
      }
    } catch {
      // Ignore close errors
    }
    session.browser = null;
    session.context = null;
    session.attachedToExisting = false;

  // Clear Layered Page Intelligence state
  elementRegistry.clear();
  previousSnapshot = null;
  }
}

function estimateEnergy(durationMs: number): { energyMWh: number } {
  // Browser ops: 0.5 mWh base + 0.1 mWh per second
  const seconds = durationMs / 1000;
  return { energyMWh: 0.5 + 0.1 * seconds };
}

// --- browser_navigate ---

const navigateInput = z.object({
  url: z.string().url().describe('URL to navigate to'),
  waitFor: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load').optional(),
});

const navigateOutput = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string(),
  energyMWh: z.number(),
});

export const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Navigate to a URL and return the page title and text content',
  inputSchema: navigateInput,
  outputSchema: navigateOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof navigateInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();
    await page.goto(parsed.url, { waitUntil: parsed.waitFor || 'load' });

    const title = await page.title();
    const content = await page.innerText('body').catch(() => '');
    const truncated = content.length > 50_000 ? content.slice(0, 50_000) : content;

    const duration = Date.now() - start;
    return {
      title,
      url: page.url(),
      content: truncated,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// --- browser_screenshot ---

const screenshotInput = z.object({
  selector: z.string().optional().describe('CSS selector to screenshot (default: full page)'),
  fullPage: z.boolean().default(true).optional(),
});

const screenshotOutput = z.object({
  filePath: z.string(),
  energyMWh: z.number(),
});

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current page or a specific element',
  inputSchema: screenshotInput,
  outputSchema: screenshotOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof screenshotInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();
    await fs.mkdir(session.screenshotDir, { recursive: true });

    const filename = `screenshot-${Date.now()}.png`;
    const filePath = join(session.screenshotDir, filename);

    if (parsed.selector) {
      const element = await page.$(parsed.selector);
      if (!element) throw new Error(`Element not found: ${parsed.selector}`);
      await element.screenshot({ path: filePath });
    } else {
      await page.screenshot({ path: filePath, fullPage: parsed.fullPage ?? true });
    }

    const duration = Date.now() - start;
    return {
      filePath,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// --- browser_click ---

const clickInput = z.object({
  selector: z.string().describe('CSS selector of element to click'),
});

const clickOutput = z.object({
  success: z.boolean(),
  energyMWh: z.number(),
});

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  description: 'Click an element on the page by CSS selector',
  inputSchema: clickInput,
  outputSchema: clickOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof clickInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();
    await page.click(parsed.selector);

    const duration = Date.now() - start;
    return {
      success: true,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// --- browser_wait_and_click ---

const waitAndClickInput = z.object({
  selector: z.string().describe('CSS selector to wait for and click'),
  timeoutMs: z.number().default(10000).optional().describe('Max milliseconds to wait for the element (default 10000)'),
  description: z.string().optional().describe('Human-readable description of what we are waiting for (e.g. "skip ad button")'),
});

const waitAndClickOutput = z.object({
  clicked: z.boolean(),
  timedOut: z.boolean(),
  waitedMs: z.number(),
  energyMWh: z.number(),
});

export const browserWaitAndClickTool: ToolDefinition = {
  name: 'browser_wait_and_click',
  description: 'Wait for an element to appear on the page and click it. Returns gracefully if element never appears (does not throw on timeout). Use for optional elements like ad skip buttons, cookie banners, or popups.',
  inputSchema: waitAndClickInput,
  outputSchema: waitAndClickOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof waitAndClickInput>;
    const timeout = parsed.timeoutMs ?? 10000;
    const start = Date.now();

    const { page } = await ensureBrowser();

    try {
      await page.waitForSelector(parsed.selector, { timeout, state: 'visible' });
      await page.click(parsed.selector);
      const waitedMs = Date.now() - start;
      return {
        clicked: true,
        timedOut: false,
        waitedMs,
        energyMWh: estimateEnergy(waitedMs).energyMWh,
      };
    } catch {
      // Element never appeared — this is expected (e.g. no ad was shown)
      const waitedMs = Date.now() - start;
      return {
        clicked: false,
        timedOut: true,
        waitedMs,
        energyMWh: estimateEnergy(waitedMs).energyMWh,
      };
    }
  },
};

// --- browser_type ---

const typeInput = z.object({
  selector: z.string().describe('CSS selector of input element'),
  text: z.string().describe('Text to type'),
  submit: z.boolean().default(false).optional().describe('Press Enter after typing'),
});

const typeOutput = z.object({
  success: z.boolean(),
  energyMWh: z.number(),
});

export const browserTypeTool: ToolDefinition = {
  name: 'browser_type',
  description: 'Type text into an input element, optionally pressing Enter to submit',
  inputSchema: typeInput,
  outputSchema: typeOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof typeInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();
    await page.fill(parsed.selector, parsed.text);

    if (parsed.submit) {
      await page.press(parsed.selector, 'Enter');
    }

    const duration = Date.now() - start;
    return {
      success: true,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// --- browser_extract ---

const extractInput = z.object({
  selector: z.string().describe('CSS selector to match elements'),
  attribute: z.string().optional().describe('Extract an attribute instead of text content'),
});

const extractOutput = z.object({
  results: z.array(z.string()),
  count: z.number(),
  energyMWh: z.number(),
});

export const browserExtractTool: ToolDefinition = {
  name: 'browser_extract',
  description: 'Extract text content or attributes from elements matching a CSS selector',
  inputSchema: extractInput,
  outputSchema: extractOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof extractInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();
    const elements = await page.$$(parsed.selector);

    const results: string[] = [];
    for (const el of elements) {
      if (parsed.attribute) {
        const value = await el.getAttribute(parsed.attribute);
        if (value !== null) results.push(value);
      } else {
        const text = await el.innerText();
        results.push(text);
      }
    }

    const duration = Date.now() - start;
    return {
      results,
      count: results.length,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// --- browser_observe ---

const observeInput = z.object({
  purpose: z.string().optional().describe('What you are looking for on the page (e.g. "search input", "login form", "compose button")'),
});

const observeOutput = z.object({
  title: z.string(),
  url: z.string(),
  interactiveElements: z.array(z.object({
    index: z.number(),
    tag: z.string(),
    type: z.string().optional(),
    text: z.string(),
    selector: z.string(),
    ariaLabel: z.string().optional(),
    placeholder: z.string().optional(),
  })),
  forms: z.array(z.object({
    action: z.string(),
    method: z.string(),
    inputs: z.array(z.string()),
  })),
  totalElements: z.number(),
  energyMWh: z.number(),
});

export const browserObserveTool: ToolDefinition = {
  name: 'browser_observe',
  description: 'Observe the current page and extract all interactive elements (buttons, inputs, links, forms). Use this to understand the page structure before deciding which elements to interact with. Returns selectors you can use with browser_click, browser_type, etc.',
  inputSchema: observeInput,
  outputSchema: observeOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof observeInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();

    // Wait for SPA rendering — many modern apps (Discord, Gmail, Twitter) need time
    // to hydrate their DOM before interactive elements appear
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      // Small delay for client-side rendering frameworks
      await page.waitForTimeout(1500);
    } catch {
      // Continue even if wait fails
    }

    const title = await page.title();
    const url = page.url();

    // Extract all interactive elements from the page
    const elements = await page.evaluate(() => {
      const interactiveSelectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="searchbox"], [contenteditable="true"], [onclick], [tabindex]';
      const els = Array.from(document.querySelectorAll(interactiveSelectors));
      const results: Array<{
        index: number;
        tag: string;
        type?: string;
        text: string;
        selector: string;
        ariaLabel?: string;
        placeholder?: string;
        visible: boolean;
      }> = [];

      for (let i = 0; i < els.length && results.length < 100; i++) {
        const el = els[i] as HTMLElement;

        // Skip invisible elements
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') continue;

        // Build a unique CSS selector
        let selector = '';
        const id = el.id;
        const ariaLabel = el.getAttribute('aria-label');
        const name = el.getAttribute('name');
        const role = el.getAttribute('role');
        const type = (el as HTMLInputElement).type;
        const dataTooltip = el.getAttribute('data-tooltip');

        if (id) {
          selector = `#${id}`;
        } else if (ariaLabel) {
          selector = `${el.tagName.toLowerCase()}[aria-label='${ariaLabel.replace(/'/g, "\\'")}']`;
        } else if (name) {
          selector = `${el.tagName.toLowerCase()}[name='${name}']`;
        } else if (dataTooltip) {
          selector = `[data-tooltip='${dataTooltip.replace(/'/g, "\\'")}']`;
        } else if (role && el.textContent) {
          const text = el.textContent.trim().slice(0, 30);
          selector = `${el.tagName.toLowerCase()}[role='${role}']:has-text("${text}")`;
        } else {
          // Fallback: use tag + classes
          const classes = Array.from(el.classList).slice(0, 3).join('.');
          selector = classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
        }

        results.push({
          index: results.length,
          tag: el.tagName.toLowerCase(),
          type: type || undefined,
          text: (el.textContent || '').trim().slice(0, 80),
          selector,
          ariaLabel: ariaLabel || undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          visible: true,
        });
      }

      return results;
    });

    // Extract forms
    const forms = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('form')).slice(0, 10).map(form => ({
        action: form.action || '',
        method: (form.method || 'GET').toUpperCase(),
        inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => {
          const name = input.getAttribute('name') || input.getAttribute('aria-label') || input.getAttribute('placeholder') || input.tagName.toLowerCase();
          const type = (input as HTMLInputElement).type || 'text';
          return `${name} (${type})`;
        }),
      }));
    });

    const duration = Date.now() - start;
    return {
      title,
      url,
      interactiveElements: elements.filter((e: { visible: boolean }) => e.visible),
      forms,
      totalElements: elements.length,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// --- browser_evaluate ---

const evaluateInput = z.object({
  script: z.string().describe('JavaScript code to execute in the page context'),
});

const evaluateOutput = z.object({
  result: z.unknown(),
  energyMWh: z.number(),
});

export const browserEvaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  description: 'Execute JavaScript code in the browser page context and return the result',
  inputSchema: evaluateInput,
  outputSchema: evaluateOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof evaluateInput>;
    const start = Date.now();

    const { page } = await ensureBrowser();
    const result = await page.evaluate(parsed.script);

    const duration = Date.now() - start;
    return {
      result,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};

// ============================================================================
// Layered Page Intelligence — browser_snapshot + browser_act
// ============================================================================

// --- Shared element extraction (reused by snapshot & act) ---

interface ExtractedElement {
  index: number;
  tag: string;
  text: string;
  selector: string;
  role?: string;
  ariaLabel?: string;
  placeholder?: string;
  type?: string;
  state: { visible: boolean; disabled: boolean; checked?: boolean; selected?: boolean; focused: boolean };
  bbox: { x: number; y: number; width: number; height: number };
}

interface ExtractedForm {
  action: string;
  method: string;
  inputs: string[];
}

async function extractElements(page: any): Promise<{ elements: ExtractedElement[]; forms: ExtractedForm[]; focusedElement: number | null }> {
  const rawResult = await page.evaluate(() => {
    const interactiveSelectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="searchbox"], [contenteditable="true"], [onclick], [tabindex]';
    const els = Array.from(document.querySelectorAll(interactiveSelectors));
    const activeEl = document.activeElement;
    const results: any[] = [];

    for (let i = 0; i < els.length && results.length < 100; i++) {
      const el = els[i] as HTMLElement;

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.display === 'none' || style.visibility === 'hidden') continue;

      // Build unique CSS selector
      let selector = '';
      const id = el.id;
      const ariaLabel = el.getAttribute('aria-label');
      const name = el.getAttribute('name');
      const role = el.getAttribute('role');
      const type = (el as HTMLInputElement).type;
      const dataTooltip = el.getAttribute('data-tooltip');
      const dataTestId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');

      if (id) {
        selector = `#${id}`;
      } else if (dataTestId) {
        selector = `[data-testid='${dataTestId}']`;
      } else if (ariaLabel) {
        selector = `${el.tagName.toLowerCase()}[aria-label='${ariaLabel.replace(/'/g, "\\'")}']`;
      } else if (name) {
        selector = `${el.tagName.toLowerCase()}[name='${name}']`;
      } else if (dataTooltip) {
        selector = `[data-tooltip='${dataTooltip.replace(/'/g, "\\'")}']`;
      } else if (role && el.textContent) {
        const text = el.textContent.trim().slice(0, 30);
        selector = `${el.tagName.toLowerCase()}[role='${role}']:has-text("${text}")`;
      } else {
        const classes = Array.from(el.classList).slice(0, 3).join('.');
        selector = classes ? `${el.tagName.toLowerCase()}.${classes}` : el.tagName.toLowerCase();
      }

      const isFocused = el === activeEl;
      const isDisabled = (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
      const isChecked = (el as HTMLInputElement).checked;
      const isSelected = (el as HTMLOptionElement).selected;

      results.push({
        index: results.length,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 80),
        selector,
        role: role || undefined,
        ariaLabel: ariaLabel || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        type: type || undefined,
        state: {
          visible: true,
          disabled: isDisabled,
          checked: isChecked !== undefined ? isChecked : undefined,
          selected: isSelected !== undefined ? isSelected : undefined,
          focused: isFocused,
        },
        bbox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }

    return results;
  });

  const rawElements: ExtractedElement[] = Array.isArray(rawResult) ? rawResult : [];

  // Extract forms
  const rawForms = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form')).slice(0, 10).map(form => ({
      action: form.action || '',
      method: (form.method || 'GET').toUpperCase(),
      inputs: Array.from(form.querySelectorAll('input, textarea, select')).map(input => {
        const name = input.getAttribute('name') || input.getAttribute('aria-label') || input.getAttribute('placeholder') || input.tagName.toLowerCase();
        const type = (input as HTMLInputElement).type || 'text';
        return `${name} (${type})`;
      }),
    }));
  });
  const forms: ExtractedForm[] = Array.isArray(rawForms) ? rawForms : [];

  // Find focused element index
  let focusedElement: number | null = null;
  for (const el of rawElements) {
    if (el.state?.focused) { focusedElement = el.index; break; }
  }

  return { elements: rawElements, forms, focusedElement };
}

// --- Element resolution helper ---

function resolveElement(index: number): RegisteredElement {
  const el = elementRegistry.get(index);
  if (!el) {
    const available = Array.from(elementRegistry.keys()).slice(0, 10).join(', ');
    throw new Error(`Element [${index}] not found. Run browser_snapshot first. Available indices: [${available}]`);
  }
  return el;
}

// --- Update element registry from extraction ---

function updateRegistry(elements: ExtractedElement[]): void {
  elementRegistry.clear();
  for (const el of elements) {
    elementRegistry.set(el.index, {
      selector: el.selector,
      tag: el.tag,
      text: el.text,
      role: el.role,
      ariaLabel: el.ariaLabel,
      placeholder: el.placeholder,
      type: el.type,
      state: { ...el.state },
      bbox: { ...el.bbox },
    });
  }
}

// --- Save snapshot state for delta computation ---

function saveSnapshotState(url: string, title: string, elements: ExtractedElement[]): void {
  const elemMap = new Map<number, RegisteredElement>();
  const selectorToIndex = new Map<string, number>();
  for (const el of elements) {
    elemMap.set(el.index, {
      selector: el.selector,
      tag: el.tag,
      text: el.text,
      role: el.role,
      ariaLabel: el.ariaLabel,
      placeholder: el.placeholder,
      type: el.type,
      state: { ...el.state },
      bbox: { ...el.bbox },
    });
    selectorToIndex.set(el.selector, el.index);
  }
  previousSnapshot = { url, title, elements: elemMap, selectorToIndex, timestamp: Date.now() };
}

// --- Delta computation ---

interface DeltaResult {
  added: number[];
  removed: number[];
  changed: Array<{ index: number; field: string; from: string; to: string }>;
}

interface ActDelta {
  added: Array<{ index: number; tag: string; text: string }>;
  removed: Array<{ index: number; tag: string; text: string }>;
  changed: Array<{ index: number; field: string; from: string; to: string }>;
  urlChanged: boolean;
  newUrl?: string;
  titleChanged: boolean;
  newTitle?: string;
}

function computeDelta(currentElements: ExtractedElement[], prev: SnapshotState | null): DeltaResult | undefined {
  if (!prev) return undefined;

  const delta: DeltaResult = { added: [], removed: [], changed: [] };

  // Build selector→element maps for current
  const currentBySelector = new Map<string, ExtractedElement>();
  for (const el of currentElements) {
    currentBySelector.set(el.selector, el);
  }

  // Check for removed elements (in previous but not in current)
  for (const [, prevEl] of prev.elements) {
    if (!currentBySelector.has(prevEl.selector)) {
      const prevIdx = prev.selectorToIndex.get(prevEl.selector);
      if (prevIdx !== undefined) delta.removed.push(prevIdx);
    }
  }

  // Check for added and changed elements
  for (const curEl of currentElements) {
    const prevIdx = prev.selectorToIndex.get(curEl.selector);
    if (prevIdx === undefined) {
      delta.added.push(curEl.index);
    } else {
      const prevEl = prev.elements.get(prevIdx)!;
      if ((curEl.text || '') !== (prevEl.text || '')) {
        delta.changed.push({ index: curEl.index, field: 'text', from: (prevEl.text || '').slice(0, 40), to: (curEl.text || '').slice(0, 40) });
      }
      if (curEl.state?.disabled !== prevEl.state?.disabled) {
        delta.changed.push({ index: curEl.index, field: 'disabled', from: String(prevEl.state?.disabled), to: String(curEl.state?.disabled) });
      }
      if (curEl.state?.visible !== prevEl.state?.visible) {
        delta.changed.push({ index: curEl.index, field: 'visible', from: String(prevEl.state?.visible), to: String(curEl.state?.visible) });
      }
      if (curEl.state?.checked !== prevEl.state?.checked) {
        delta.changed.push({ index: curEl.index, field: 'checked', from: String(prevEl.state?.checked), to: String(curEl.state?.checked) });
      }
    }
  }

  // Only return if there are actual changes
  if (delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0) {
    return undefined;
  }
  return delta;
}

function computeActDelta(
  currentElements: ExtractedElement[],
  currentUrl: string,
  currentTitle: string,
  prev: SnapshotState | null,
): ActDelta {
  const result: ActDelta = {
    added: [],
    removed: [],
    changed: [],
    urlChanged: false,
    titleChanged: false,
  };

  if (!prev) return result;

  if (currentUrl !== prev.url) {
    result.urlChanged = true;
    result.newUrl = currentUrl;
  }
  if (currentTitle !== prev.title) {
    result.titleChanged = true;
    result.newTitle = currentTitle;
  }

  const currentBySelector = new Map<string, ExtractedElement>();
  for (const el of currentElements) {
    currentBySelector.set(el.selector, el);
  }

  for (const [, prevEl] of prev.elements) {
    if (!currentBySelector.has(prevEl.selector)) {
      const prevIdx = prev.selectorToIndex.get(prevEl.selector);
      if (prevIdx !== undefined) {
        result.removed.push({ index: prevIdx, tag: prevEl.tag, text: (prevEl.text || '').slice(0, 40) });
      }
    }
  }

  for (const curEl of currentElements) {
    const prevIdx = prev.selectorToIndex.get(curEl.selector);
    if (prevIdx === undefined) {
      result.added.push({ index: curEl.index, tag: curEl.tag, text: (curEl.text || '').slice(0, 40) });
    } else {
      const prevEl = prev.elements.get(prevIdx)!;
      const curText = curEl.text || '';
      const prevText = prevEl.text || '';
      if (curText !== prevText) {
        result.changed.push({ index: curEl.index, field: 'text', from: prevText.slice(0, 40), to: curText.slice(0, 40) });
      }
      if (curEl.state?.disabled !== prevEl.state?.disabled) {
        result.changed.push({ index: curEl.index, field: 'disabled', from: String(prevEl.state?.disabled), to: String(curEl.state?.disabled) });
      }
      if (curEl.state?.visible !== prevEl.state?.visible) {
        result.changed.push({ index: curEl.index, field: 'visible', from: String(prevEl.state?.visible), to: String(curEl.state?.visible) });
      }
      if (curEl.state?.checked !== prevEl.state?.checked) {
        result.changed.push({ index: curEl.index, field: 'checked', from: String(prevEl.state?.checked), to: String(curEl.state?.checked) });
      }
    }
  }

  return result;
}

// --- ASCII Wireframe Generation ---

function generateAsciiWireframe(
  elements: ExtractedElement[],
  viewportWidth: number,
  viewportHeight: number,
): string {
  const COLS = 80;
  const ROWS = 30;
  const scaleX = COLS / viewportWidth;
  const scaleY = ROWS / viewportHeight;
  const grid: string[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));

  // Draw largest elements first so smaller ones overlay
  const sorted = [...elements]
    .filter(e => e.bbox.width > 0 && e.bbox.height > 0)
    .sort((a, b) => (b.bbox.width * b.bbox.height) - (a.bbox.width * a.bbox.height));

  for (const el of sorted) {
    const l = Math.max(0, Math.round(el.bbox.x * scaleX));
    const t = Math.max(0, Math.round(el.bbox.y * scaleY));
    const r = Math.min(COLS - 1, Math.round((el.bbox.x + el.bbox.width) * scaleX));
    const b = Math.min(ROWS - 1, Math.round((el.bbox.y + el.bbox.height) * scaleY));
    if (r - l < 2 || b - t < 1) continue;

    // Draw box borders
    for (let x = l; x <= r; x++) { grid[t][x] = '-'; grid[b][x] = '-'; }
    for (let y = t; y <= b; y++) { grid[y][l] = '|'; grid[y][r] = '|'; }
    grid[t][l] = '+'; grid[t][r] = '+'; grid[b][l] = '+'; grid[b][r] = '+';

    // Label: [index] + tag or text
    const textLabel = el.tag === 'input' ? '___' : el.text.slice(0, 8);
    const label = `[${el.index}]${textLabel}`;
    if (t + 1 < b) {
      for (let i = 0; i < label.length && l + 1 + i < r; i++) {
        grid[t + 1][l + 1 + i] = label[i];
      }
    }
  }

  return grid.map(row => row.join('').trimEnd()).join('\n');
}

// --- browser_snapshot tool ---

const snapshotInput = z.object({
  level: z.number().min(0).max(4).default(0).optional().describe('Intelligence tier: 0=DOM index (~300 tokens), 1=+accessibility tree, 2=+ASCII wireframe, 3=element screenshot (requires screenshotElement), 4=full page screenshot'),
  screenshotElement: z.number().optional().describe('Element index to screenshot (level 3)'),
  purpose: z.string().optional().describe('What you are looking for on the page'),
});

const snapshotElementSchema = z.object({
  index: z.number(),
  tag: z.string(),
  text: z.string(),
  selector: z.string(),
  role: z.string().optional(),
  ariaLabel: z.string().optional(),
  placeholder: z.string().optional(),
  type: z.string().optional(),
  state: z.object({
    visible: z.boolean(),
    disabled: z.boolean(),
    checked: z.boolean().optional(),
    selected: z.boolean().optional(),
    focused: z.boolean(),
  }),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});

const snapshotOutput = z.object({
  title: z.string(),
  url: z.string(),
  focusedElement: z.number().nullable(),
  elements: z.array(snapshotElementSchema),
  totalElements: z.number(),
  forms: z.array(z.object({ action: z.string(), method: z.string(), inputs: z.array(z.string()) })),
  accessibilityTree: z.string().optional(),
  wireframe: z.string().optional(),
  elementScreenshotPath: z.string().optional(),
  fullScreenshotPath: z.string().optional(),
  delta: z.object({
    added: z.array(z.number()),
    removed: z.array(z.number()),
    changed: z.array(z.object({ index: z.number(), field: z.string(), from: z.string(), to: z.string() })),
  }).optional(),
  energyMWh: z.number(),
});

export const browserSnapshotTool: ToolDefinition = {
  name: 'browser_snapshot',
  description: 'Capture a layered page intelligence snapshot. Level 0 (default): indexed interactive elements with state & bounding boxes (~300 tokens). Level 1: adds accessibility tree. Level 2: adds ASCII wireframe layout. Level 3: targeted element screenshot by [index]. Level 4: full page screenshot. Use browser_act to interact by [index].',
  inputSchema: snapshotInput,
  outputSchema: snapshotOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof snapshotInput>;
    const level = parsed.level ?? 0;
    const start = Date.now();

    const { page } = await ensureBrowser();

    // Wait for SPA rendering
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } catch { /* continue */ }

    const title = await page.title();
    const url = page.url();

    // Level 0: Always extract indexed elements
    const { elements, forms, focusedElement } = await extractElements(page);

    // Compute delta against previous snapshot
    const delta = computeDelta(elements, previousSnapshot);

    // Update internal state
    updateRegistry(elements);
    saveSnapshotState(url, title, elements);

    const result: any = {
      title,
      url,
      focusedElement,
      elements,
      totalElements: elements.length,
      forms,
      delta,
      energyMWh: 0, // set at end
    };

    // Level 1: Accessibility tree
    if (level >= 1) {
      try {
        const tree = await page.accessibility.snapshot();
        if (tree) {
          result.accessibilityTree = JSON.stringify(tree, null, 1).slice(0, 3000);
        }
      } catch {
        result.accessibilityTree = '(accessibility tree unavailable)';
      }
    }

    // Level 2: ASCII wireframe
    if (level >= 2) {
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      result.wireframe = generateAsciiWireframe(elements, viewport.width, viewport.height);
    }

    // Level 3: Targeted element screenshot
    if (level >= 3 && parsed.screenshotElement !== undefined) {
      const targetEl = elementRegistry.get(parsed.screenshotElement);
      if (targetEl) {
        try {
          await fs.mkdir(session.screenshotDir, { recursive: true });
          const filePath = join(session.screenshotDir, `element-${parsed.screenshotElement}-${Date.now()}.png`);
          const handle = await page.$(targetEl.selector);
          if (handle) {
            await handle.screenshot({ path: filePath });
            result.elementScreenshotPath = filePath;
          }
        } catch { /* screenshot failed, continue */ }
      }
    }

    // Level 4: Full page screenshot
    if (level >= 4) {
      try {
        await fs.mkdir(session.screenshotDir, { recursive: true });
        const filePath = join(session.screenshotDir, `snapshot-full-${Date.now()}.png`);
        await page.screenshot({ path: filePath, fullPage: true });
        result.fullScreenshotPath = filePath;
      } catch { /* screenshot failed, continue */ }
    }

    const duration = Date.now() - start;
    result.energyMWh = estimateEnergy(duration).energyMWh;
    return result;
  },
};

// --- browser_act tool ---

const actInput = z.object({
  action: z.enum(['click', 'type', 'select', 'hover', 'scroll', 'focus', 'clear']).describe('Action to perform'),
  element: z.number().describe('Element [index] from browser_snapshot'),
  text: z.string().optional().describe('Text to type or option value to select'),
  submit: z.boolean().default(false).optional().describe('Press Enter after typing'),
  direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (for scroll action)'),
  amount: z.number().default(300).optional().describe('Scroll pixels (for scroll action)'),
});

const actOutput = z.object({
  success: z.boolean(),
  action: z.string(),
  elementDescription: z.string(),
  delta: z.object({
    added: z.array(z.object({ index: z.number(), tag: z.string(), text: z.string() })),
    removed: z.array(z.object({ index: z.number(), tag: z.string(), text: z.string() })),
    changed: z.array(z.object({ index: z.number(), field: z.string(), from: z.string(), to: z.string() })),
    urlChanged: z.boolean(),
    newUrl: z.string().optional(),
    titleChanged: z.boolean(),
    newTitle: z.string().optional(),
  }),
  energyMWh: z.number(),
});

export const browserActTool: ToolDefinition = {
  name: 'browser_act',
  description: 'Perform an action on a page element by its [index] from browser_snapshot. Returns a delta of what changed on the page — no need to re-snapshot after every action. Actions: click, type, select, hover, scroll, focus, clear.',
  inputSchema: actInput,
  outputSchema: actOutput,
  tags: ['browser'],
  async execute(input) {
    const parsed = input as z.infer<typeof actInput>;
    const start = Date.now();

    const target = resolveElement(parsed.element);
    const { page } = await ensureBrowser();
    const elementDesc = `[${parsed.element}] <${target.tag}> "${target.text.slice(0, 30)}"`;

    // Execute the action
    switch (parsed.action) {
      case 'click':
        await page.click(target.selector);
        break;
      case 'type':
        if (!parsed.text) throw new Error('text is required for type action');
        await page.fill(target.selector, parsed.text);
        if (parsed.submit) {
          await page.press(target.selector, 'Enter');
        }
        break;
      case 'select':
        if (!parsed.text) throw new Error('text is required for select action');
        await page.selectOption(target.selector, parsed.text);
        break;
      case 'hover':
        await page.hover(target.selector);
        break;
      case 'scroll': {
        const handle = await page.$(target.selector);
        if (handle) {
          await handle.scrollIntoViewIfNeeded();
          const amt = parsed.amount ?? 300;
          const dir = parsed.direction ?? 'down';
          const dx = dir === 'right' ? amt : dir === 'left' ? -amt : 0;
          const dy = dir === 'down' ? amt : dir === 'up' ? -amt : 0;
          await page.mouse.wheel(dx, dy);
        }
        break;
      }
      case 'focus':
        await page.focus(target.selector);
        break;
      case 'clear':
        await page.fill(target.selector, '');
        break;
    }

    // Wait briefly for page to react
    try {
      await page.waitForTimeout(800);
    } catch { /* continue */ }

    // Re-extract elements and compute delta
    const newTitle = await page.title();
    const newUrl = page.url();
    const { elements: newElements } = await extractElements(page);

    const delta = computeActDelta(newElements, newUrl, newTitle, previousSnapshot);

    // Update state
    updateRegistry(newElements);
    saveSnapshotState(newUrl, newTitle, newElements);

    const duration = Date.now() - start;
    return {
      success: true,
      action: parsed.action,
      elementDescription: elementDesc,
      delta,
      energyMWh: estimateEnergy(duration).energyMWh,
    };
  },
};
