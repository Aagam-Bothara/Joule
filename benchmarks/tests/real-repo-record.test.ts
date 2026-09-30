import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CrewScalingRecord } from '../crew-scaling/types.js';
import { observedRepoTools } from '../real-repo/record.js';

describe('real-repo tool observations', () => {
  it('counts a repo edit as an attempted write even when the host edit gate accepted none', () => {
    const records = [{ agentResults: [{ toolCalls: 2, acceptedWrites: 0, tools: [
      { tool: 'repo_read', durationMs: 1, ok: true },
      { tool: 'repo_edit', durationMs: 1, ok: false },
    ] }] }] as CrewScalingRecord[];

    expect(observedRepoTools(records)).toEqual({
      callsByName: { repo_read: 1, repo_edit: 1 },
      writeAttempts: 1,
      unidentifiedCalls: 0,
    });
  });

  it('reports missing tool identity instead of claiming zero writes', () => {
    const records = [{ agentResults: [{ toolCalls: 2, tools: [null, { tool: 'repo_read', durationMs: 1 }] }] }] as unknown as CrewScalingRecord[];

    expect(observedRepoTools(records)).toEqual({
      callsByName: { repo_read: 1 },
      writeAttempts: 0,
      unidentifiedCalls: 1,
    });
  });

  it('confirms named calls and zero writes in the committed old-parser smoke artifact', () => {
    const file = new URL('../experiments/real-repo-smoke/staged/runs.jsonl', import.meta.url);
    const records = readFileSync(file, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as CrewScalingRecord);
    const observed = observedRepoTools(records);

    expect(observed.callsByName.repo_shell).toBeGreaterThan(0);
    expect(observed.callsByName.repo_read).toBeGreaterThan(0);
    expect(observed.writeAttempts).toBe(0);
    expect(observed.unidentifiedCalls).toBe(0);
  });
});
