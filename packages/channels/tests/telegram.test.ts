import { describe, it, expect } from 'vitest';
import { splitTelegramMessage } from '../src/telegram.js';

describe('Telegram Channel', () => {
  describe('splitTelegramMessage', () => {
    it('should return single chunk for short messages', () => {
      const result = splitTelegramMessage('Hello world', 4096);
      expect(result).toEqual(['Hello world']);
    });

    it('should not split messages at exact limit', () => {
      const text = 'x'.repeat(4096);
      const result = splitTelegramMessage(text, 4096);
      expect(result).toEqual([text]);
    });

    it('should split at newline when possible', () => {
      const line1 = 'a'.repeat(3000);
      const line2 = 'b'.repeat(3000);
      const text = `${line1}\n${line2}`;
      const result = splitTelegramMessage(text, 4096);

      expect(result.length).toBe(2);
      expect(result[0]).toBe(line1);
      expect(result[1]).toBe(line2);
    });

    it('should split at space when no newline available', () => {
      const word = 'hello ';
      const text = word.repeat(700); // ~4200 chars
      const result = splitTelegramMessage(text, 4096);

      expect(result.length).toBe(2);
      expect(result[0].length).toBeLessThanOrEqual(4096);
    });

    it('should hard split when no whitespace available', () => {
      const text = 'x'.repeat(8192);
      const result = splitTelegramMessage(text, 4096);

      expect(result.length).toBe(2);
      expect(result[0].length).toBe(4096);
      expect(result[1].length).toBe(4096);
    });

    it('should handle empty string', () => {
      const result = splitTelegramMessage('', 4096);
      expect(result).toEqual(['']);
    });

    it('should preserve total content across chunks', () => {
      const text = 'word '.repeat(1000); // ~5000 chars
      const chunks = splitTelegramMessage(text, 4096);
      // All chunks should be within limit
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(4096);
      }
      // Reassembled content should contain all words
      const reassembled = chunks.join(' ');
      const originalWords = text.trim().split(/\s+/);
      const reassembledWords = reassembled.trim().split(/\s+/);
      expect(reassembledWords.length).toBe(originalWords.length);
    });
  });
});
