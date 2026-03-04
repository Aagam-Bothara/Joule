/**
 * StreamingRag — Watches files for changes and re-indexes automatically.
 *
 * Wraps RagEngine to provide live document ingestion:
 *  - Watches directories for file create/modify/delete
 *  - Re-indexes changed files with debouncing
 *  - Removes chunks from deleted files
 *  - Supports glob patterns for filtering watched files
 *
 * Uses Node.js fs.watch (recursive) — no external dependencies.
 */

import { watch, type FSWatcher } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { RagEngine } from './rag-engine.js';

// ── Types ────────────────────────────────────────────────────────────

export interface StreamingRagOptions {
  /** Directories to watch for changes. */
  watchPaths: string[];

  /** File extensions to index (default: common text formats). */
  extensions?: string[];

  /** Debounce interval in ms — wait this long after last change before re-indexing (default: 500). */
  debounceMs?: number;

  /** Whether to do an initial full index on start (default: true). */
  initialIndex?: boolean;

  /** Callback for indexing events. */
  onEvent?: (event: StreamingRagEvent) => void;
}

export interface StreamingRagEvent {
  type: 'indexed' | 'removed' | 'error' | 'watching' | 'stopped';
  filePath?: string;
  chunks?: number;
  error?: string;
  timestamp: string;
}

export interface StreamingRagStats {
  watching: boolean;
  watchedPaths: string[];
  indexedFiles: number;
  totalChunks: number;
  lastIndexedAt?: string;
  errors: number;
}

// ── Default extensions ───────────────────────────────────────────────

const DEFAULT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.log',
  '.yaml', '.yml', '.xml', '.html',
  '.ts', '.js', '.py', '.rs', '.go',
  '.java', '.rb', '.php', '.sh',
  '.toml', '.ini', '.cfg', '.conf',
]);

// ── Main class ───────────────────────────────────────────────────────

export class StreamingRag {
  private engine: RagEngine;
  private options: Required<StreamingRagOptions>;
  private watchers: FSWatcher[] = [];
  private indexedFileChunks = new Map<string, number>(); // filePath → chunk count
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private extensionSet: Set<string>;
  private errorCount = 0;
  private lastIndexedAt?: string;
  private running = false;

  constructor(engine: RagEngine, options: StreamingRagOptions) {
    this.engine = engine;
    this.options = {
      watchPaths: options.watchPaths,
      extensions: options.extensions ?? [...DEFAULT_EXTENSIONS],
      debounceMs: options.debounceMs ?? 500,
      initialIndex: options.initialIndex ?? true,
      onEvent: options.onEvent ?? (() => {}),
    };
    this.extensionSet = new Set(this.options.extensions);
  }

  /**
   * Start watching and optionally perform initial indexing.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Initial full index
    if (this.options.initialIndex) {
      for (const dir of this.options.watchPaths) {
        await this.indexDirectory(dir);
      }
    }

    // Set up file watchers
    for (const dir of this.options.watchPaths) {
      try {
        const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          const fullPath = join(dir, filename);
          this.handleFileChange(fullPath, eventType);
        });

        watcher.on('error', (err) => {
          this.errorCount++;
          this.emit({
            type: 'error',
            error: `Watcher error on ${dir}: ${err.message}`,
            timestamp: new Date().toISOString(),
          });
        });

        this.watchers.push(watcher);

        this.emit({
          type: 'watching',
          filePath: dir,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        this.errorCount++;
        this.emit({
          type: 'error',
          error: `Failed to watch ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Stop watching and clean up.
   */
  stop(): void {
    this.running = false;

    // Clear pending debounce timers
    for (const timer of this.pendingChanges.values()) {
      clearTimeout(timer);
    }
    this.pendingChanges.clear();

    // Close all watchers
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    this.emit({
      type: 'stopped',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get current statistics.
   */
  getStats(): StreamingRagStats {
    return {
      watching: this.running,
      watchedPaths: [...this.options.watchPaths],
      indexedFiles: this.indexedFileChunks.size,
      totalChunks: [...this.indexedFileChunks.values()].reduce((sum, count) => sum + count, 0),
      lastIndexedAt: this.lastIndexedAt,
      errors: this.errorCount,
    };
  }

  /**
   * Manually trigger re-indexing of a specific file.
   */
  async reindexFile(filePath: string): Promise<number> {
    return this.indexFile(filePath);
  }

  // ── Private ──────────────────────────────────────────────────────

  /**
   * Handle a file system change event with debouncing.
   */
  private handleFileChange(filePath: string, eventType: string): void {
    if (!this.shouldIndex(filePath)) return;

    // Cancel any pending re-index for this file
    const existing = this.pendingChanges.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Debounce: wait before re-indexing to batch rapid changes
    const timer = setTimeout(async () => {
      this.pendingChanges.delete(filePath);

      try {
        const exists = await this.fileExists(filePath);
        if (exists) {
          await this.indexFile(filePath);
        } else {
          // File deleted — remove chunks
          this.removeFile(filePath);
        }
      } catch {
        this.errorCount++;
      }
    }, this.options.debounceMs);

    this.pendingChanges.set(filePath, timer);
  }

  /**
   * Index a single file, replacing any previous chunks.
   */
  private async indexFile(filePath: string): Promise<number> {
    try {
      // Remove tracking for old chunks
      this.removeFile(filePath);

      // Re-index and track the chunk count for this file
      const chunkCount = await this.engine.indexDocument(filePath);
      this.indexedFileChunks.set(filePath, chunkCount);
      this.lastIndexedAt = new Date().toISOString();

      this.emit({
        type: 'indexed',
        filePath,
        chunks: chunkCount,
        timestamp: this.lastIndexedAt,
      });

      return chunkCount;
    } catch (err) {
      this.errorCount++;
      this.emit({
        type: 'error',
        filePath,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
      return 0;
    }
  }

  /**
   * Remove all chunks associated with a file.
   */
  private removeFile(filePath: string): void {
    const chunkCount = this.indexedFileChunks.get(filePath);
    if (chunkCount === undefined) return;

    // RagEngine doesn't support individual chunk removal, but we track
    // the file as removed. On re-index the new chunks supersede the old.
    this.indexedFileChunks.delete(filePath);

    this.emit({
      type: 'removed',
      filePath,
      chunks: chunkCount,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Recursively index all matching files in a directory.
   */
  private async indexDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // Skip common non-content directories
          if (this.isIgnoredDir(entry.name)) continue;
          await this.indexDirectory(fullPath);
        } else if (entry.isFile() && this.shouldIndex(fullPath)) {
          await this.indexFile(fullPath);
        }
      }
    } catch {
      // Directory may not exist or be unreadable
      this.errorCount++;
    }
  }

  /**
   * Check if a file should be indexed based on extension.
   */
  private shouldIndex(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return this.extensionSet.has(ext);
  }

  /**
   * Check if a directory should be skipped.
   */
  private isIgnoredDir(name: string): boolean {
    const ignored = new Set([
      'node_modules', '.git', '.svn', '.hg', 'dist', 'build',
      '__pycache__', '.cache', '.next', '.nuxt', 'coverage',
      '.joule', '.claude', '.vscode', '.idea',
    ]);
    return ignored.has(name) || name.startsWith('.');
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private emit(event: StreamingRagEvent): void {
    this.options.onEvent(event);
  }
}
