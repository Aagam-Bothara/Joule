import { useState, useCallback, useRef } from 'react';

interface StreamChunk {
  content: string;
  tokenIndex?: number;
}

interface ProgressEvent {
  step: number;
  totalSteps: number;
  description: string;
  toolName?: string;
  status: string;
}

export function useTaskStream() {
  const [chunks, setChunks] = useState<string[]>([]);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [result, setResult] = useState<any>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const startStream = useCallback(async (description: string, budget: string = 'medium') => {
    setChunks([]);
    setProgress([]);
    setResult(null);
    setError(null);
    setStreaming(true);

    abortRef.current = new AbortController();

    try {
      const res = await fetch('/tasks/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, budget }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        throw new Error(`Stream request failed: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventType = line.slice(7).trim();
            // next data line
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              // Determine event type from data shape
              if (parsed.content !== undefined) {
                setChunks(prev => [...prev, parsed.content]);
              } else if (parsed.step !== undefined) {
                setProgress(prev => [...prev, parsed]);
              } else if (parsed.status !== undefined && parsed.synthesis !== undefined) {
                setResult(parsed);
              }
            } catch {
              // Skip malformed data
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setStreaming(false);
    }
  }, []);

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  return {
    chunks,
    fullText: chunks.join(''),
    progress,
    result,
    streaming,
    error,
    startStream,
    stopStream,
  };
}
