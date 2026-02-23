import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  captchaSolveImageTool,
  captchaSolveMathTool,
  captchaSolveTextTool,
  captchaSolveExternalTool,
  solveMathExpression,
  _setSleep,
} from '../src/builtin/captcha.js';

// Make sleep instant for all tests
const originalSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('CAPTCHA Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Override sleep to resolve instantly during tests
    _setSleep(() => Promise.resolve());
  });

  afterEach(() => {
    _setSleep(originalSleep);
    vi.unstubAllGlobals();
  });

  // ─── captcha_solve_math ───

  describe('captcha_solve_math', () => {
    it('has correct name and tags', () => {
      expect(captchaSolveMathTool.name).toBe('captcha_solve_math');
      expect(captchaSolveMathTool.tags).toContain('captcha');
    });

    it('solves simple addition', async () => {
      const result = await captchaSolveMathTool.execute({ expression: '3 + 7' });
      expect(result.numericAnswer).toBe(10);
      expect(result.answer).toBe('10');
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('solves subtraction', async () => {
      const result = await captchaSolveMathTool.execute({ expression: '15 - 8' });
      expect(result.numericAnswer).toBe(7);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('solves multiplication', async () => {
      const result = await captchaSolveMathTool.execute({ expression: '6 * 4' });
      expect(result.numericAnswer).toBe(24);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('solves division', async () => {
      const result = await captchaSolveMathTool.execute({ expression: '20 / 5' });
      expect(result.numericAnswer).toBe(4);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('solves word-based math ("three plus five")', async () => {
      const result = await captchaSolveMathTool.execute({ expression: 'three plus five' });
      expect(result.numericAnswer).toBe(8);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('solves "What is 12 times 3?"', async () => {
      const result = await captchaSolveMathTool.execute({ expression: 'What is 12 times 3?' });
      expect(result.numericAnswer).toBe(36);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('solves chained expressions', async () => {
      const result = await captchaSolveMathTool.execute({ expression: '3 + 5 - 2' });
      expect(result.numericAnswer).toBe(6);
      expect(result.confidence).toBeGreaterThan(0.9);
    });

    it('handles "What is five minus two?"', async () => {
      const result = await captchaSolveMathTool.execute({ expression: 'What is five minus two?' });
      expect(result.numericAnswer).toBe(3);
    });

    it('normalizes expression alias (math field)', async () => {
      const result = await captchaSolveMathTool.execute({ math: '8 + 2' } as any);
      expect(result.numericAnswer).toBe(10);
    });

    it('normalizes expression alias (equation field)', async () => {
      const result = await captchaSolveMathTool.execute({ equation: '9 - 4' } as any);
      expect(result.numericAnswer).toBe(5);
    });

    it('returns low confidence for unparseable input', async () => {
      const result = await captchaSolveMathTool.execute({ expression: 'hello world' });
      expect(result.confidence).toBe(0);
    });

    it('reports energy usage', async () => {
      const result = await captchaSolveMathTool.execute({ expression: '1 + 1' });
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  // ─── solveMathExpression (unit) ───

  describe('solveMathExpression', () => {
    it('handles addition with Unicode ×', () => {
      const result = solveMathExpression('3 × 4');
      expect(result.value).toBe(12);
    });

    it('handles Unicode ÷', () => {
      const result = solveMathExpression('10 ÷ 2');
      expect(result.value).toBe(5);
    });

    it('handles exponentiation', () => {
      const result = solveMathExpression('2 ^ 3');
      expect(result.value).toBe(8);
    });

    it('handles modulo', () => {
      const result = solveMathExpression('10 % 3');
      expect(result.value).toBe(1);
    });

    it('handles negative numbers', () => {
      const result = solveMathExpression('-5 + 3');
      expect(result.value).toBe(-2);
    });

    it('handles decimal numbers', () => {
      const result = solveMathExpression('2.5 + 1.5');
      expect(result.value).toBe(4);
    });

    it('returns confidence 0 for gibberish', () => {
      const result = solveMathExpression('xyz abc');
      expect(result.confidence).toBe(0);
    });

    it('handles "calculate" prefix', () => {
      const result = solveMathExpression('calculate 7 + 3');
      expect(result.value).toBe(10);
    });

    it('handles word number twenty', () => {
      const result = solveMathExpression('twenty plus five');
      expect(result.value).toBe(25);
    });

    it('just a number returns confidence 0.5', () => {
      const result = solveMathExpression('42');
      expect(result.value).toBe(42);
      expect(result.confidence).toBe(0.5);
    });
  });

  // ─── captcha_solve_text ───

  describe('captcha_solve_text', () => {
    it('has correct name and tags', () => {
      expect(captchaSolveTextTool.name).toBe('captcha_solve_text');
      expect(captchaSolveTextTool.tags).toContain('captcha');
    });

    it('answers color questions', async () => {
      const result = await captchaSolveTextTool.execute({ question: 'What color is the sky?' });
      expect(result.answer).toBe('blue');
      expect(result.confidence).toBeGreaterThan(0.8);
      expect(result.strategy).toBe('color-lookup');
    });

    it('answers "What colour is grass?"', async () => {
      const result = await captchaSolveTextTool.execute({ question: 'What colour is grass?' });
      expect(result.answer).toBe('green');
    });

    it('reverses words ("Type dog backwards")', async () => {
      const result = await captchaSolveTextTool.execute({ question: 'Type dog backwards' });
      expect(result.answer).toBe('god');
      expect(result.confidence).toBeGreaterThan(0.9);
      expect(result.strategy).toBe('reverse-word');
    });

    it('reverses with "reverse the word"', async () => {
      const result = await captchaSolveTextTool.execute({ question: 'Reverse the word hello' });
      expect(result.answer).toBe('olleh');
      expect(result.strategy).toBe('reverse-word');
    });

    it('counts letters in words', async () => {
      const result = await captchaSolveTextTool.execute({
        question: 'How many times does the letter l appear in hello?',
      });
      expect(result.answer).toBe('2');
      expect(result.strategy).toBe('letter-count');
    });

    it('compares numbers (larger)', async () => {
      const result = await captchaSolveTextTool.execute({
        question: 'Which is larger, 42 or 17?',
      });
      expect(result.answer).toBe('42');
      expect(result.strategy).toBe('comparison');
    });

    it('compares numbers (smaller)', async () => {
      const result = await captchaSolveTextTool.execute({
        question: 'Which is smaller, 42 or 17?',
      });
      expect(result.answer).toBe('17');
      expect(result.strategy).toBe('comparison');
    });

    it('answers day sequence questions', async () => {
      const result = await captchaSolveTextTool.execute({
        question: 'What day comes after Wednesday?',
      });
      expect(result.answer).toBe('thursday');
      expect(result.strategy).toBe('day-sequence');
    });

    it('solves embedded math ("What is 5 + 3?")', async () => {
      const result = await captchaSolveTextTool.execute({
        question: 'What is 5 + 3?',
      });
      expect(result.answer).toBe('8');
      expect(result.strategy).toBe('embedded-math');
    });

    it('returns fallback for unknown questions', async () => {
      const result = await captchaSolveTextTool.execute({
        question: 'What is the meaning of life?',
      });
      expect(result.strategy).toBe('fallback');
      expect(result.confidence).toBe(0);
    });

    it('reports energy usage', async () => {
      const result = await captchaSolveTextTool.execute({ question: 'What color is snow?' });
      expect(result.energyMWh).toBeGreaterThan(0);
    });
  });

  // ─── captcha_solve_image ───

  describe('captcha_solve_image', () => {
    it('has correct name and tags', () => {
      expect(captchaSolveImageTool.name).toBe('captcha_solve_image');
      expect(captchaSolveImageTool.tags).toContain('captcha');
      expect(captchaSolveImageTool.tags).toContain('browser');
    });

    it('rejects invalid base64', async () => {
      await expect(
        captchaSolveImageTool.execute({ imageBase64: '!!invalid!!' }),
      ).rejects.toThrow();
    });

    it('rejects too-small image data', async () => {
      const tiny = Buffer.from('hi').toString('base64');
      await expect(
        captchaSolveImageTool.execute({ imageBase64: tiny }),
      ).rejects.toThrow('Image data too small');
    });

    it('rejects unrecognized format', async () => {
      // 100 bytes of zeros — no magic bytes
      const zeros = Buffer.alloc(100, 0).toString('base64');
      await expect(
        captchaSolveImageTool.execute({ imageBase64: zeros }),
      ).rejects.toThrow('Unrecognized image format');
    });

    it('processes a valid PNG image (small)', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const padding = Buffer.alloc(100, 0x42);
      const fakeImage = Buffer.concat([pngHeader, padding]);

      const result = await captchaSolveImageTool.execute({
        imageBase64: fakeImage.toString('base64'),
      });

      expect(result.strategy).toBeDefined();
      expect(result.energyMWh).toBeGreaterThan(0);
    });

    it('processes a valid JPEG image', async () => {
      const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      const padding = Buffer.alloc(100, 0x42);
      const fakeImage = Buffer.concat([jpegHeader, padding]);

      const result = await captchaSolveImageTool.execute({
        imageBase64: fakeImage.toString('base64'),
      });

      expect(result.strategy).toBeDefined();
    });

    it('accepts math hint for image CAPTCHA', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const padding = Buffer.alloc(100, 0x42);
      const fakeImage = Buffer.concat([pngHeader, padding]);

      const result = await captchaSolveImageTool.execute({
        imageBase64: fakeImage.toString('base64'),
        hint: 'math: 5 + 3',
      });

      expect(result.solution).toBe('8');
      expect(result.strategy).toBe('math-parse');
    });

    it('normalizes image alias (image field)', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const padding = Buffer.alloc(100, 0x42);
      const fakeImage = Buffer.concat([pngHeader, padding]);

      const result = await captchaSolveImageTool.execute({
        image: fakeImage.toString('base64'),
      } as any);

      expect(result.strategy).toBeDefined();
    });
  });

  // ─── captcha_solve_external ───

  describe('captcha_solve_external', () => {
    it('has correct name and tags', () => {
      expect(captchaSolveExternalTool.name).toBe('captcha_solve_external');
      expect(captchaSolveExternalTool.tags).toContain('captcha');
      expect(captchaSolveExternalTool.tags).toContain('network');
    });

    it('requires confirmation', () => {
      expect(captchaSolveExternalTool.requiresConfirmation).toBe(true);
    });

    it('calls 2captcha API correctly', async () => {
      const mockFetch = vi.fn()
        // Submit response
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'task-123' }),
        })
        // Poll response — solved
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ status: 1, request: 'solved-token-abc' }),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await captchaSolveExternalTool.execute({
        siteKey: 'test-site-key',
        pageUrl: 'https://example.com',
        type: 'recaptcha-v2',
        apiKey: 'test-api-key',
        service: '2captcha',
        timeoutMs: 30000,
      });

      expect(result.token).toBe('solved-token-abc');
      expect(result.service).toBe('2captcha');
      expect(result.solveTimeMs).toBeGreaterThanOrEqual(0);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('handles 2captcha submit failure', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ status: 0, request: 'ERROR_WRONG_USER_KEY' }),
      });

      vi.stubGlobal('fetch', mockFetch);

      await expect(
        captchaSolveExternalTool.execute({
          siteKey: 'key',
          pageUrl: 'https://example.com',
          type: 'recaptcha-v2',
          apiKey: 'bad-key',
          service: '2captcha',
          timeoutMs: 5000,
        }),
      ).rejects.toThrow('2Captcha submit failed');
    });

    it('calls CapSolver API correctly', async () => {
      const mockFetch = vi.fn()
        // Create task response
        .mockResolvedValueOnce({
          json: () => Promise.resolve({ errorId: 0, taskId: 'cap-task-456' }),
        })
        // Get result response
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            errorId: 0,
            status: 'ready',
            solution: { gRecaptchaResponse: 'capsolver-token-xyz' },
          }),
        });

      vi.stubGlobal('fetch', mockFetch);

      const result = await captchaSolveExternalTool.execute({
        siteKey: 'test-site-key',
        pageUrl: 'https://example.com',
        type: 'hcaptcha',
        apiKey: 'test-cap-key',
        service: 'capsolver',
        timeoutMs: 30000,
      });

      expect(result.token).toBe('capsolver-token-xyz');
      expect(result.service).toBe('capsolver');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('handles CapSolver create failure', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        json: () => Promise.resolve({ errorId: 1, errorDescription: 'Invalid key' }),
      });

      vi.stubGlobal('fetch', mockFetch);

      await expect(
        captchaSolveExternalTool.execute({
          siteKey: 'key',
          pageUrl: 'https://example.com',
          type: 'hcaptcha',
          apiKey: 'bad-key',
          service: 'capsolver',
          timeoutMs: 5000,
        }),
      ).rejects.toThrow('CapSolver create failed');
    });
  });
});
