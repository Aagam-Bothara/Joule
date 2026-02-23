export interface VoiceConfig {
  enabled?: boolean;
  wakeWord?: string;
  sttProvider?: 'ollama' | 'openai' | 'local' | 'windows';
  ttsProvider?: 'system' | 'elevenlabs' | 'none';
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  silenceThresholdMs?: number;
  sampleRate?: number;
  ollamaUrl?: string;
  openaiApiKey?: string;
}
