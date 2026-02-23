import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { VoiceConfig } from '@joule/shared';

const execFileAsync = promisify(execFile);

const DEFAULT_WAKE_WORD = 'hey joule';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_SILENCE_THRESHOLD_MS = 1500;
const DEFAULT_MAX_RECORD_SECS = 10;

export interface VoiceEvent {
  type: 'listening' | 'wake_word' | 'recording' | 'transcribing' | 'processing' | 'speaking' | 'error' | 'stopped';
  text?: string;
  error?: string;
}

export type VoiceEventCallback = (event: VoiceEvent) => void;

/** Callback invoked when a voice command is recognized. Returns the response text. */
export type CommandHandler = (text: string) => Promise<string>;

export class VoiceEngine {
  private wakeWord: string;
  private sttProvider: 'ollama' | 'openai' | 'local' | 'windows';
  private ttsProvider: 'system' | 'elevenlabs' | 'none';
  private sampleRate: number;
  private silenceThresholdMs: number;
  private maxRecordSecs: number;
  private ollamaUrl: string;
  private openaiApiKey?: string;
  private elevenLabsApiKey?: string;
  private elevenLabsVoiceId: string;
  private running = false;

  constructor(config?: VoiceConfig) {
    this.wakeWord = config?.wakeWord ?? DEFAULT_WAKE_WORD;
    // Auto-detect: use Windows built-in speech recognition on Win32
    this.sttProvider = config?.sttProvider ?? (process.platform === 'win32' ? 'windows' : 'ollama');
    this.ttsProvider = config?.ttsProvider ?? 'system';
    this.sampleRate = config?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.silenceThresholdMs = config?.silenceThresholdMs ?? DEFAULT_SILENCE_THRESHOLD_MS;
    this.maxRecordSecs = DEFAULT_MAX_RECORD_SECS;
    this.ollamaUrl = config?.ollamaUrl ?? 'http://localhost:11434';
    this.openaiApiKey = config?.openaiApiKey;
    this.elevenLabsApiKey = config?.elevenLabsApiKey;
    this.elevenLabsVoiceId = config?.elevenLabsVoiceId ?? '21m00Tcm4TlvDq8ikWAM';
  }

  get isRunning(): boolean {
    return this.running;
  }

  // --- Text-to-Speech ---

  getTtsCommand(text: string): { command: string; args: string[] } | null {
    if (this.ttsProvider === 'none') return null;

    if (this.ttsProvider === 'system') {
      const platform = process.platform;
      if (platform === 'darwin') {
        return { command: 'say', args: [text] };
      } else if (platform === 'linux') {
        return { command: 'espeak', args: [text] };
      } else if (platform === 'win32') {
        return {
          command: 'powershell',
          args: ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${text.replace(/'/g, "''")}')`],
        };
      }
    }

    return null;
  }

  async speak(text: string): Promise<void> {
    if (this.ttsProvider === 'none') return;

    if (this.ttsProvider === 'elevenlabs' && this.elevenLabsApiKey) {
      await this.speakElevenLabs(text);
      return;
    }

    const cmd = this.getTtsCommand(text);
    if (!cmd) return;

    try {
      await execFileAsync(cmd.command, cmd.args, { timeout: 30_000 });
    } catch {
      // TTS failure is non-critical
    }
  }

  private async speakElevenLabs(text: string): Promise<void> {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': this.elevenLabsApiKey!,
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_monolingual_v1',
          }),
        },
      );

      if (!response.ok) return;

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const tmpFile = path.join(os.tmpdir(), `joule-tts-${Date.now()}.mp3`);
      await fs.writeFile(tmpFile, audioBuffer);

      const platform = process.platform;
      if (platform === 'darwin') {
        await execFileAsync('afplay', [tmpFile]);
      } else if (platform === 'linux') {
        await execFileAsync('mpg123', [tmpFile]).catch(() =>
          execFileAsync('aplay', [tmpFile])
        );
      } else if (platform === 'win32') {
        await execFileAsync('powershell', ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${tmpFile}').PlaySync()`]);
      }

      await fs.unlink(tmpFile).catch(() => {});
    } catch {
      const cmd = this.getTtsCommand(text);
      if (cmd) {
        await execFileAsync(cmd.command, cmd.args, { timeout: 30_000 }).catch(() => {});
      }
    }
  }

  // --- Windows Speech Recognition (listen + transcribe in one step) ---

  /**
   * Listen from the microphone and return transcribed text using Windows
   * built-in System.Speech.Recognition. No external tools needed.
   * Uses a PowerShell script file to avoid escaping issues.
   */
  async listenWindows(maxDurationSecs?: number): Promise<string> {
    const timeout = maxDurationSecs ?? this.maxRecordSecs;

    // Write PS1 script to temp file (avoids all escaping issues)
    const scriptPath = path.join(os.tmpdir(), 'joule-stt.ps1');
    await fs.writeFile(scriptPath, [
      'Add-Type -AssemblyName System.Speech',
      '$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
      '$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
      '$rec.SetInputToDefaultAudioDevice()',
      `$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(${timeout})`,
      '$rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(2)',
      `$rec.BabbleTimeout = [TimeSpan]::FromSeconds(${timeout})`,
      'try {',
      `    $result = $rec.Recognize([TimeSpan]::FromSeconds(${timeout}))`,
      '    if ($result -ne $null -and $result.Text -ne $null -and $result.Text.Length -gt 0) {',
      '        [Console]::Out.Write($result.Text)',
      '    }',
      '} catch {',
      '    [Console]::Error.WriteLine($_.Exception.Message)',
      '    exit 1',
      '} finally {',
      '    $rec.Dispose()',
      '}',
    ].join('\n'), 'utf-8');

    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        resolve('');
      }, (timeout + 8) * 1000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || code === null) {
          resolve(stdout.trim());
        } else {
          const err = stderr.trim();
          if (err.includes('No audio input') || err.includes('AudioDevice')) {
            reject(new Error('No microphone found'));
          } else {
            reject(new Error(err || `Speech recognition failed (exit ${code})`));
          }
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      const checkInterval = setInterval(() => {
        if (!this.running) {
          clearInterval(checkInterval);
          proc.kill();
        }
      }, 200);
      proc.on('close', () => clearInterval(checkInterval));
    });
  }

  // --- Audio Recording (for non-Windows STT providers) ---

  async recordAudio(maxDurationSecs?: number): Promise<string> {
    const duration = maxDurationSecs ?? this.maxRecordSecs;
    const tmpFile = path.join(os.tmpdir(), `joule-rec-${Date.now()}.wav`);

    try {
      if (process.platform === 'win32') {
        await this.recordWindows(tmpFile, duration);
      } else {
        await this.recordSox(tmpFile, duration);
      }

      const stat = await fs.stat(tmpFile).catch(() => null);
      if (!stat || stat.size < 1000) {
        await fs.unlink(tmpFile).catch(() => {});
        return '';
      }

      return tmpFile;
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      throw err;
    }
  }

  private async recordWindows(outputPath: string, durationSecs: number): Promise<void> {
    const psScript = `
$duration = ${durationSecs}
$sampleRate = ${this.sampleRate}
$outputPath = '${outputPath.replace(/'/g, "''")}'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class WavRecorder {
    [DllImport("winmm.dll")]
    static extern int waveInOpen(out IntPtr hWaveIn, int deviceId, ref WAVEFORMATEX lpFormat, IntPtr dwCallback, IntPtr dwInstance, int fdwOpen);
    [DllImport("winmm.dll")]
    static extern int waveInPrepareHeader(IntPtr hWaveIn, ref WAVEHDR lpWaveHdr, int uSize);
    [DllImport("winmm.dll")]
    static extern int waveInAddBuffer(IntPtr hWaveIn, ref WAVEHDR lpWaveHdr, int uSize);
    [DllImport("winmm.dll")]
    static extern int waveInStart(IntPtr hWaveIn);
    [DllImport("winmm.dll")]
    static extern int waveInStop(IntPtr hWaveIn);
    [DllImport("winmm.dll")]
    static extern int waveInUnprepareHeader(IntPtr hWaveIn, ref WAVEHDR lpWaveHdr, int uSize);
    [DllImport("winmm.dll")]
    static extern int waveInClose(IntPtr hWaveIn);
    [DllImport("winmm.dll")]
    static extern int waveInGetNumDevs();

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEHDR {
        public IntPtr lpData;
        public int dwBufferLength;
        public int dwBytesRecorded;
        public IntPtr dwUser;
        public int dwFlags;
        public int dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }

    public static bool HasDevice() { return waveInGetNumDevs() > 0; }

    public static void Record(string path, int sampleRate, int durationMs) {
        if (waveInGetNumDevs() == 0) throw new Exception("No microphone found");
        var fmt = new WAVEFORMATEX();
        fmt.wFormatTag = 1;
        fmt.nChannels = 1;
        fmt.nSamplesPerSec = sampleRate;
        fmt.wBitsPerSample = 16;
        fmt.nBlockAlign = (short)(fmt.nChannels * fmt.wBitsPerSample / 8);
        fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
        fmt.cbSize = 0;

        IntPtr hWaveIn;
        int result = waveInOpen(out hWaveIn, -1, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
        if (result != 0) throw new Exception("waveInOpen failed: " + result);

        int bufferSize = fmt.nAvgBytesPerSec * (durationMs / 1000 + 1);
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        var hdr = new WAVEHDR();
        hdr.lpData = buffer;
        hdr.dwBufferLength = bufferSize;

        waveInPrepareHeader(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
        waveInAddBuffer(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
        waveInStart(hWaveIn);
        Thread.Sleep(durationMs);
        waveInStop(hWaveIn);
        Thread.Sleep(100);

        int recorded = hdr.dwBytesRecorded;
        byte[] data = new byte[recorded];
        if (recorded > 0) Marshal.Copy(buffer, data, 0, recorded);

        waveInUnprepareHeader(hWaveIn, ref hdr, Marshal.SizeOf(hdr));
        waveInClose(hWaveIn);
        Marshal.FreeHGlobal(buffer);

        using (var fs = new FileStream(path, FileMode.Create))
        using (var bw = new BinaryWriter(fs)) {
            bw.Write(new char[] { 'R','I','F','F' });
            bw.Write(36 + recorded);
            bw.Write(new char[] { 'W','A','V','E' });
            bw.Write(new char[] { 'f','m','t',' ' });
            bw.Write(16);
            bw.Write(fmt.wFormatTag);
            bw.Write(fmt.nChannels);
            bw.Write(fmt.nSamplesPerSec);
            bw.Write(fmt.nAvgBytesPerSec);
            bw.Write(fmt.nBlockAlign);
            bw.Write(fmt.wBitsPerSample);
            bw.Write(new char[] { 'd','a','t','a' });
            bw.Write(recorded);
            bw.Write(data);
        }
    }
}
'@ -ReferencedAssemblies System.IO

if (-not [WavRecorder]::HasDevice()) { Write-Error "No microphone device found"; exit 1 }
[WavRecorder]::Record($outputPath, $sampleRate, $duration * 1000)
`;

    return new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', psScript,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timeout = setTimeout(() => { proc.kill(); resolve(); }, (durationSecs + 8) * 1000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 || code === null) resolve();
        else reject(new Error(stderr.trim() || `Recording failed (exit ${code})`));
      });

      proc.on('error', (err) => { clearTimeout(timeout); reject(err); });

      const checkInterval = setInterval(() => {
        if (!this.running) { clearInterval(checkInterval); proc.kill(); }
      }, 200);
      proc.on('close', () => clearInterval(checkInterval));
    });
  }

  private async recordSox(outputPath: string, durationSecs: number): Promise<void> {
    const silenceDuration = (this.silenceThresholdMs / 1000).toFixed(1);
    const args = [
      '-r', String(this.sampleRate), '-c', '1', '-b', '16',
      outputPath,
      'silence', '1', '0.3', '3%', '1', silenceDuration, '3%',
      'trim', '0', String(durationSecs),
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn('rec', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const timeout = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, (durationSecs + 3) * 1000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0 || code === null) resolve();
        else reject(new Error(`rec exited with code ${code}`));
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('SoX not found. Install: brew install sox (macOS) or apt install sox (Linux)'));
        } else reject(err);
      });

      const checkInterval = setInterval(() => {
        if (!this.running) { clearInterval(checkInterval); proc.kill('SIGTERM'); }
      }, 200);
      proc.on('close', () => clearInterval(checkInterval));
    });
  }

  // --- Speech-to-Text ---

  getSttUrl(): string {
    if (this.sttProvider === 'ollama') return `${this.ollamaUrl}/api/generate`;
    if (this.sttProvider === 'openai') return 'https://api.openai.com/v1/audio/transcriptions';
    return '';
  }

  async transcribe(audioPath: string): Promise<string> {
    if (this.sttProvider === 'ollama') return this.transcribeOllama(audioPath);
    if (this.sttProvider === 'openai') return this.transcribeOpenAI(audioPath);
    return this.transcribeLocal(audioPath);
  }

  private async transcribeOllama(audioPath: string): Promise<string> {
    const audioData = await fs.readFile(audioPath);
    const base64 = audioData.toString('base64');
    const response = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'whisper', prompt: 'Transcribe this audio.', images: [base64] }),
    });
    if (!response.ok) throw new Error(`Ollama STT failed: ${response.status}`);
    const data = await response.json() as { response?: string };
    return data.response ?? '';
  }

  private async transcribeOpenAI(audioPath: string): Promise<string> {
    if (!this.openaiApiKey) throw new Error('OpenAI API key required for STT');
    const audioData = await fs.readFile(audioPath);
    const formData = new FormData();
    formData.append('file', new Blob([audioData]), 'audio.wav');
    formData.append('model', 'whisper-1');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiApiKey}` },
      body: formData,
    });
    if (!response.ok) throw new Error(`OpenAI STT failed: ${response.status}`);
    const data = await response.json() as { text?: string };
    return data.text ?? '';
  }

  private async transcribeLocal(audioPath: string): Promise<string> {
    // Use python -m whisper (more reliable than bare whisper command on Windows)
    const pyScript = [
      'import whisper, sys, json',
      'model = whisper.load_model("base")',
      `result = model.transcribe(r"${audioPath.replace(/\\/g, '\\\\')}", fp16=False)`,
      'print(result["text"].strip())',
    ].join('; ');

    try {
      const { stdout } = await execFileAsync('python', ['-c', pyScript], { timeout: 60_000 });
      return stdout.trim();
    } catch (err) {
      // Fallback: try whisper CLI directly
      try {
        const { stdout } = await execFileAsync('whisper', [
          audioPath, '--model', 'base', '--output_format', 'txt', '--output_dir', os.tmpdir(),
        ], { timeout: 60_000 });
        return stdout.trim();
      } catch {
        throw new Error('Local whisper not available. Install: pip install openai-whisper');
      }
    }
  }

  // --- Wake Word Detection ---

  matchesWakeWord(transcript: string): boolean {
    const normalized = transcript.toLowerCase().trim();
    return normalized.startsWith(this.wakeWord) || normalized.includes(this.wakeWord);
  }

  stripWakeWord(transcript: string): string {
    const normalized = transcript.toLowerCase().trim();
    const idx = normalized.indexOf(this.wakeWord);
    if (idx === -1) return transcript.trim();
    return transcript.slice(idx + this.wakeWord.length).trim();
  }

  // --- Audio Utilities ---

  computeRmsEnergy(samples: Int16Array): number {
    if (samples.length === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      const normalized = samples[i] / 32768;
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / samples.length);
  }

  isSilence(samples: Int16Array, threshold = 0.01): boolean {
    return this.computeRmsEnergy(samples) < threshold;
  }

  estimateEnergy(durationMs: number): number {
    return 0.2 * (durationMs / 1000);
  }

  // --- Voice Loop ---

  /**
   * Start the continuous voice loop.
   *
   * On Windows with STT=windows: uses System.Speech.Recognition directly
   * (listens from mic → returns text, no WAV file needed).
   *
   * On other platforms: records audio → transcribes → processes.
   */
  async startLoop(onEvent: VoiceEventCallback, onCommand?: CommandHandler): Promise<void> {
    this.running = true;
    let silentCycles = 0;

    while (this.running) {
      try {
        onEvent({ type: 'listening' });

        let transcript: string;

        if (this.sttProvider === 'windows') {
          transcript = await this.listenWindows();
        } else {
          // Other providers: record WAV → transcribe
          const audioPath = await this.recordAudio();

          if (!this.running) {
            if (audioPath) await fs.unlink(audioPath).catch(() => {});
            break;
          }

          if (!audioPath) continue;

          onEvent({ type: 'transcribing' });
          try {
            transcript = await this.transcribe(audioPath);
          } finally {
            await fs.unlink(audioPath).catch(() => {});
          }
        }

        if (!this.running) break;
        if (!transcript.trim()) {
          silentCycles++;
          if (silentCycles === 3) {
            onEvent({
              type: 'error',
              error: 'No speech detected after 3 attempts. Check your microphone:\n' +
                '  1. Windows Settings > Privacy & Security > Microphone > ON\n' +
                '  2. "Let desktop apps access your microphone" > ON\n' +
                '  3. Settings > System > Sound > Input > correct mic selected\n' +
                '  4. Make sure mic is not muted',
            });
          }
          continue;
        }
        silentCycles = 0; // Reset on successful detection

        // Check for exit commands
        const lower = transcript.toLowerCase().trim();
        if (lower === 'exit' || lower === 'quit' || lower === 'stop' || lower === 'goodbye') {
          this.running = false;
          break;
        }

        // Wake word detection
        let commandText: string;
        if (this.wakeWord) {
          if (!this.matchesWakeWord(transcript)) {
            continue;
          }
          onEvent({ type: 'wake_word' });
          commandText = this.stripWakeWord(transcript);

          // If wake word was said alone, listen again for the command
          if (!commandText.trim()) {
            onEvent({ type: 'recording' });
            if (this.sttProvider === 'windows') {
              commandText = await this.listenWindows(15);
            } else {
              const cmdPath = await this.recordAudio(15);
              if (!cmdPath) continue;
              onEvent({ type: 'transcribing' });
              try {
                commandText = await this.transcribe(cmdPath);
              } finally {
                await fs.unlink(cmdPath).catch(() => {});
              }
            }
          }
        } else {
          commandText = transcript;
        }

        if (!commandText.trim()) continue;

        // Execute the command
        if (onCommand) {
          onEvent({ type: 'processing', text: commandText.trim() });
          const response = await onCommand(commandText.trim());
          if (response) {
            onEvent({ type: 'speaking', text: response });
            await this.speak(response);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'error', error: msg });

        // Fatal errors — stop the loop
        if (msg.includes('No microphone') || msg.includes('not found') ||
            msg.includes('ENOENT') || msg.includes('SoX') || msg.includes('No audio')) {
          this.running = false;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    onEvent({ type: 'stopped' });
  }

  stopLoop(): void {
    this.running = false;
  }
}
