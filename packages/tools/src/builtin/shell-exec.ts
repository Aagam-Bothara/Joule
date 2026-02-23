import { z } from 'zod';
import { execFile } from 'node:child_process';
import type { ToolDefinition } from '@joule/shared';

const inputSchema = z.object({
  command: z.string().describe('Shell command to execute'),
  cwd: z.string().optional().describe('Working directory'),
  timeoutMs: z.number().default(30_000).describe('Execution timeout in ms'),
});

const outputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
});

export const shellExecTool: ToolDefinition = {
  name: 'shell_exec',
  description: 'Execute a shell command and return stdout, stderr, and exit code',
  inputSchema,
  outputSchema,
  tags: ['system', 'dangerous'],
  requiresConfirmation: true,
  async execute(input) {
    const parsed = input as z.infer<typeof inputSchema>;
    const isWindows = process.platform === 'win32';
    // On Windows, use PowerShell for better scripting support (COM objects, etc.)
    const shell = isWindows ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWindows
      ? ['-NoProfile', '-NonInteractive', '-Command', parsed.command]
      : ['-c', parsed.command];

    return new Promise((resolve) => {
      execFile(
        shell,
        shellArgs,
        {
          cwd: parsed.cwd,
          timeout: parsed.timeoutMs,
          maxBuffer: 5 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error && 'code' in error ? (error.code as number) ?? 1 : 0,
          });
        },
      );
    });
  },
};
