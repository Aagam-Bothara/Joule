import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing tools
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}));

import { execFile } from 'node:child_process';
import {
  osScreenshotTool,
  osMouseTool,
  osKeyboardTool,
  osWindowTool,
  osClipboardTool,
  configureOsAutomation,
} from '../src/builtin/os-automation.js';

const mockExecFile = vi.mocked(execFile);

function mockSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    callback(null, stdout, stderr);
    return undefined as any;
  });
}

function mockFailure(stderr: string, code = 1) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, callback: any) => {
    const err = Object.assign(new Error(stderr), { code });
    callback(err, '', stderr);
    return undefined as any;
  });
}

describe('OS Automation Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- os_screenshot ---

  describe('os_screenshot', () => {
    it('should have correct metadata', () => {
      expect(osScreenshotTool.name).toBe('os_screenshot');
      expect(osScreenshotTool.tags).toContain('os-automation');
      expect(osScreenshotTool.tags).toContain('system');
      expect(osScreenshotTool.requiresConfirmation).toBeFalsy();
    });

    it('should capture full screen', async () => {
      mockSuccess('1920x1080');
      const result = await osScreenshotTool.execute({});
      expect(result.path).toMatch(/os-screenshot-\d+\.png$/);
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.energyMWh).toBeGreaterThan(0);
    });

    it('should capture a region', async () => {
      mockSuccess('400x300');
      const result = await osScreenshotTool.execute({
        region: { x: 100, y: 200, width: 400, height: 300 },
      });
      expect(result.width).toBe(400);
      expect(result.height).toBe(300);
    });

    it('should throw on PowerShell failure', async () => {
      mockFailure('Screenshot error');
      await expect(osScreenshotTool.execute({})).rejects.toThrow('Screenshot failed');
    });
  });

  // --- os_mouse ---

  describe('os_mouse', () => {
    it('should have correct metadata', () => {
      expect(osMouseTool.name).toBe('os_mouse');
      expect(osMouseTool.tags).toContain('dangerous');
      expect(osMouseTool.requiresConfirmation).toBe(true);
    });

    it('should click at coordinates', async () => {
      mockSuccess('500,400');
      const result = await osMouseTool.execute({ action: 'click', x: 500, y: 400 });
      expect(result.success).toBe(true);
      expect(result.x).toBe(500);
      expect(result.y).toBe(400);
    });

    it('should move cursor', async () => {
      mockSuccess('200,300');
      const result = await osMouseTool.execute({ action: 'move', x: 200, y: 300 });
      expect(result.success).toBe(true);
    });

    it('should throw when coordinates missing for click', async () => {
      await expect(osMouseTool.execute({ action: 'click' })).rejects.toThrow('requires x and y');
    });

    it('should throw when scrollAmount missing for scroll', async () => {
      await expect(osMouseTool.execute({ action: 'scroll' })).rejects.toThrow('requires scrollAmount');
    });

    it('should scroll', async () => {
      mockSuccess('500,500');
      const result = await osMouseTool.execute({ action: 'scroll', scrollAmount: -3 });
      expect(result.success).toBe(true);
    });
  });

  // --- os_keyboard ---

  describe('os_keyboard', () => {
    it('should have correct metadata', () => {
      expect(osKeyboardTool.name).toBe('os_keyboard');
      expect(osKeyboardTool.tags).toContain('dangerous');
      expect(osKeyboardTool.requiresConfirmation).toBe(true);
    });

    it('should type text', async () => {
      mockSuccess('OK');
      const result = await osKeyboardTool.execute({ action: 'type', text: 'Hello World' });
      expect(result.success).toBe(true);
    });

    it('should press a single key', async () => {
      mockSuccess('OK');
      const result = await osKeyboardTool.execute({ action: 'press', key: 'enter' });
      expect(result.success).toBe(true);
    });

    it('should press hotkey combo', async () => {
      mockSuccess('OK');
      const result = await osKeyboardTool.execute({
        action: 'hotkey', key: 'c', modifiers: ['ctrl'],
      });
      expect(result.success).toBe(true);
    });

    it('should throw for unknown key', async () => {
      await expect(
        osKeyboardTool.execute({ action: 'press', key: 'unknownkey123' }),
      ).rejects.toThrow('Unknown key');
    });
  });

  // --- os_window ---

  describe('os_window', () => {
    it('should have correct metadata', () => {
      expect(osWindowTool.name).toBe('os_window');
      expect(osWindowTool.tags).toContain('os-automation');
      expect(osWindowTool.requiresConfirmation).toBe(true);
    });

    it('should list windows', async () => {
      const mockWindows = JSON.stringify([
        { title: 'Notepad', pid: 1234, processName: 'notepad', x: 0, y: 0, width: 800, height: 600 },
        { title: 'Chrome', pid: 5678, processName: 'chrome', x: 100, y: 100, width: 1200, height: 800 },
      ]);
      mockSuccess(mockWindows);

      const result = await osWindowTool.execute({ action: 'list' });
      expect(result.success).toBe(true);
      expect(result.windows).toHaveLength(2);
      expect(result.windows![0].title).toBe('Notepad');
      expect(result.windows![1].title).toBe('Chrome');
    });

    it('should handle single window in list', async () => {
      const single = JSON.stringify({ title: 'Notepad', pid: 1234, processName: 'notepad', x: 0, y: 0, width: 800, height: 600 });
      mockSuccess(single);

      const result = await osWindowTool.execute({ action: 'list' });
      expect(result.success).toBe(true);
      expect(result.windows).toHaveLength(1);
    });

    it('should focus a window', async () => {
      mockSuccess('OK');
      const result = await osWindowTool.execute({ action: 'focus', title: 'Notepad' });
      expect(result.success).toBe(true);
    });

    it('should minimize a window', async () => {
      mockSuccess('OK');
      const result = await osWindowTool.execute({ action: 'minimize', title: 'Chrome' });
      expect(result.success).toBe(true);
    });
  });

  // --- os_clipboard ---

  describe('os_clipboard', () => {
    it('should have correct metadata', () => {
      expect(osClipboardTool.name).toBe('os_clipboard');
      expect(osClipboardTool.tags).toContain('os-automation');
      expect(osClipboardTool.requiresConfirmation).toBeFalsy();
    });

    it('should read clipboard', async () => {
      mockSuccess('clipboard content here');
      const result = await osClipboardTool.execute({ action: 'read' });
      expect(result.success).toBe(true);
      expect(result.content).toBe('clipboard content here');
    });

    it('should write to clipboard', async () => {
      mockSuccess('');
      const result = await osClipboardTool.execute({ action: 'write', content: 'new data' });
      expect(result.success).toBe(true);
    });

    it('should throw when writing without content', async () => {
      await expect(
        osClipboardTool.execute({ action: 'write' }),
      ).rejects.toThrow('requires content');
    });
  });

  // --- configureOsAutomation ---

  describe('configureOsAutomation', () => {
    it('should not throw with config', () => {
      expect(() => configureOsAutomation({
        screenshotDir: '/tmp/shots',
        commandTimeoutMs: 20_000,
      })).not.toThrow();
    });

    it('should not throw without config', () => {
      expect(() => configureOsAutomation()).not.toThrow();
    });
  });
});
