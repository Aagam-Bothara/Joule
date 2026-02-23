import { describe, it, expect } from 'vitest';
import { splitMessage } from '../src/discord.js';

describe('Discord Utilities', () => {
  it('returns single chunk for short messages', () => {
    const chunks = splitMessage('Hello, world!', 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('Hello, world!');
  });

  it('returns single chunk at exact limit', () => {
    const text = 'a'.repeat(2000);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(1);
  });

  it('splits long messages at newline boundaries', () => {
    const line = 'A'.repeat(900);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('splits long messages at space boundaries', () => {
    const words = Array(500).fill('hello').join(' ');
    const chunks = splitMessage(words, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('hard splits when no natural break point', () => {
    const text = 'a'.repeat(5000);
    const chunks = splitMessage(text, 2000);
    expect(chunks.length).toBe(3); // 2000 + 2000 + 1000
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(2000);
    expect(chunks[2].length).toBe(1000);
  });

  it('handles empty string', () => {
    const chunks = splitMessage('', 2000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('preserves content integrity across chunks', () => {
    const words = Array(300).fill('test').join(' ');
    const chunks = splitMessage(words, 100);
    const reassembled = chunks.join(' ');
    // All original words should be present
    expect(reassembled.split(/\s+/).filter(w => w === 'test').length).toBe(300);
  });
});
