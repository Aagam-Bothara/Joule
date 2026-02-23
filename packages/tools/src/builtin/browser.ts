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
