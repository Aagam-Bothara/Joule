import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoiceEngine } from '../src/voice.js';

describe('VoiceEngine', () => {
  let engine: VoiceEngine;

  beforeEach(() => {
    engine = new VoiceEngine({
      wakeWord: 'hey joule',
      sttProvider: 'ollama',
      ttsProvider: 'system',
      ollamaUrl: 'http://localhost:11434',
    });
  });

  describe('TTS command generation', () => {
    it('should generate macOS TTS command', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const cmd = engine.getTtsCommand('Hello world');
      expect(cmd).toEqual({ command: 'say', args: ['Hello world'] });

      Object.defineProperty(process, 'platform', { value: original });
    });

    it('should generate Linux TTS command', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const cmd = engine.getTtsCommand('Hello world');
      expect(cmd).toEqual({ command: 'espeak', args: ['Hello world'] });

      Object.defineProperty(process, 'platform', { value: original });
    });

    it('should generate Windows TTS command', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const cmd = engine.getTtsCommand('Hello world');
      expect(cmd).not.toBeNull();
      expect(cmd!.command).toBe('powershell');
      expect(cmd!.args[0]).toBe('-NoProfile');

      Object.defineProperty(process, 'platform', { value: original });
    });

    it('should return null for none TTS provider', () => {
      const noTts = new VoiceEngine({ ttsProvider: 'none' });
      const cmd = noTts.getTtsCommand('Hello');
      expect(cmd).toBeNull();
    });
  });

  describe('Wake word detection', () => {
    it('should match wake word at start of transcript', () => {
      expect(engine.matchesWakeWord('hey joule what is the weather')).toBe(true);
    });

    it('should match wake word anywhere in transcript', () => {
      expect(engine.matchesWakeWord('I said hey joule')).toBe(true);
    });

    it('should be case insensitive', () => {
      expect(engine.matchesWakeWord('Hey Joule do something')).toBe(true);
    });

    it('should not match unrelated text', () => {
      expect(engine.matchesWakeWord('hello world')).toBe(false);
    });

    it('should strip wake word from transcript', () => {
      expect(engine.stripWakeWord('hey joule what time is it')).toBe('what time is it');
    });

    it('should handle transcript without wake word', () => {
      expect(engine.stripWakeWord('what time is it')).toBe('what time is it');
    });
  });

  describe('Audio utilities', () => {
    it('should compute RMS energy of samples', () => {
      // Silent audio
      const silence = new Int16Array(100);
      expect(engine.computeRmsEnergy(silence)).toBe(0);

      // Loud audio (max amplitude)
      const loud = new Int16Array(100).fill(32767);
      const rms = engine.computeRmsEnergy(loud);
      expect(rms).toBeGreaterThan(0.9);
      expect(rms).toBeLessThanOrEqual(1);
    });

    it('should detect silence correctly', () => {
      const silence = new Int16Array(100);
      expect(engine.isSilence(silence)).toBe(true);

      const loud = new Int16Array(100).fill(16384);
      expect(engine.isSilence(loud)).toBe(false);
    });

    it('should handle empty sample array', () => {
      expect(engine.computeRmsEnergy(new Int16Array(0))).toBe(0);
    });
  });

  describe('STT URL construction', () => {
    it('should return Ollama URL for ollama provider', () => {
      expect(engine.getSttUrl()).toBe('http://localhost:11434/api/generate');
    });

    it('should return OpenAI URL for openai provider', () => {
      const openai = new VoiceEngine({ sttProvider: 'openai' });
      expect(openai.getSttUrl()).toBe('https://api.openai.com/v1/audio/transcriptions');
    });

    it('should return empty for local provider', () => {
      const local = new VoiceEngine({ sttProvider: 'local' });
      expect(local.getSttUrl()).toBe('');
    });
  });

  describe('Config defaults', () => {
    it('should use default wake word', () => {
      const defaultEngine = new VoiceEngine();
      expect(defaultEngine.matchesWakeWord('hey joule test')).toBe(true);
    });

    it('should use custom wake word', () => {
      const custom = new VoiceEngine({ wakeWord: 'jarvis' });
      expect(custom.matchesWakeWord('jarvis do something')).toBe(true);
      expect(custom.matchesWakeWord('hey joule test')).toBe(false);
    });
  });

  describe('Energy estimation', () => {
    it('should estimate energy for voice processing', () => {
      // 1 second of processing = ~0.2 mWh
      expect(engine.estimateEnergy(1000)).toBeCloseTo(0.2);
      expect(engine.estimateEnergy(5000)).toBeCloseTo(1.0);
      expect(engine.estimateEnergy(0)).toBe(0);
    });
  });

  describe('Voice loop', () => {
    it('should start and stop', async () => {
      const events: string[] = [];

      // Stop after first event
      const promise = engine.startLoop((event) => {
        events.push(event.type);
        if (event.type === 'listening') {
          engine.stopLoop();
        }
      });

      await promise;

      expect(events).toContain('listening');
      expect(events).toContain('stopped');
      expect(engine.isRunning).toBe(false);
    });
  });
});
