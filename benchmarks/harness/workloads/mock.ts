/**
 * Mock workloads — deterministic scenarios that exercise every escalation path.
 *
 * The scripted "SLM" and "LLM" differ in capability per scenario, so the
 * counterfactual runs (slm-only, llm-only) give ground truth for escalation
 * precision / recall, and the adaptive run shows whether the policy escalated
 * only when it was needed.
 */

import { z } from 'zod';
import type { ModelRequest, ToolDefinition } from '@joule/shared';
import type { ScriptEntry, Workload } from '../types.js';

const toolCall = (toolName: string, toolArgs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action: 'tool_call', thought: 'next step', toolName, toolArgs, plan: ['do the step', 'answer'], ...extra });
const final = (answer: string) => JSON.stringify({ action: 'final_answer', answer });
const giveUp = (reason: string) => JSON.stringify({ action: 'give_up', reason });

const lastUser = (req: ModelRequest): string =>
  [...req.messages].reverse().find(m => m.role === 'user')?.content ?? '';
const advised = (req: ModelRequest) => /<advice /.test(lastUser(req));
const handedOff = (req: ModelRequest) => /taking over an in-progress task/.test(req.messages[0]?.content ?? '');
/** A CONSULT request (the Consultant's system prompt), as opposed to an agent turn at the LLM tier. */
const isConsult = (req: ModelRequest) => /senior engineer advising/.test(req.system ?? '');
const sawObservation = (req: ModelRequest, pattern: RegExp) => req.messages.some(m => m.role === 'user' && pattern.test(m.content));

function tool(name: string, description: string, execute: (args: Record<string, unknown>) => Promise<unknown>): ToolDefinition {
  return { name, description, inputSchema: z.object({}).passthrough(), outputSchema: z.any(), execute } as ToolDefinition;
}

const echoTool = () => tool('lookup', 'Look up a record by key', async (a) => ({ record: `value-of-${a.key ?? 'default'}` }));

export const MOCK_WORKLOADS: Workload[] = [
  // 1. The SLM handles it alone. Escalating here would be a false positive.
  {
    id: 'slm-capable',
    description: 'Look up the customer record for key 42 and report its value.',
    complexity: 'low',
    tools: () => [echoTool()],
    scripts: {
      slm: [toolCall('lookup', { key: 42 }), final('The record is value-of-42')],
      llm: [toolCall('lookup', { key: 42 }), final('The record is value-of-42')],
    },
    verify: r => /value-of-42/.test(r.result ?? ''),
  },

  // 2. The SLM writes the fix and verifies it with a test command (deterministic verifier).
  {
    id: 'verified-fix',
    description: 'Fix the null check in auth.ts and make the tests pass.',
    complexity: 'medium',
    tools: () => [
      tool('file_write', 'Write a file', async () => ({ written: true })),
      tool('shell_exec', 'Run a shell command', async (a) => {
        const cmd = String(a.command ?? '');
        const ok = /npm test/.test(cmd);
        return { stdout: ok ? '12 passed' : '', stderr: ok ? '' : 'unknown command', exitCode: ok ? 0 : 127 };
      }),
    ],
    scripts: {
      slm: [
        toolCall('file_write', { path: 'auth.ts', content: 'if (!user) return;' }),
        toolCall('shell_exec', { command: 'npm test' }, { verify: { type: 'command_exit', command: 'npm test' } }),
        final('Added the null check; tests pass (12 passed).'),
      ],
      llm: [
        toolCall('file_write', { path: 'auth.ts', content: 'if (!user) return;' }),
        toolCall('shell_exec', { command: 'npm test' }, { verify: { type: 'command_exit', command: 'npm test' } }),
        final('Added the null check; tests pass (12 passed).'),
      ],
    },
    verify: r => r.status === 'completed' && r.stepResults.some(s => s.toolName === 'shell_exec' && s.verified === true),
  },

  // 3. The SLM is stuck on one decision (wrong region); one consultation unblocks it.
  {
    id: 'needs-consult',
    description: 'Deploy the service to the compliant region.',
    complexity: 'medium',
    tools: () => [
      tool('deploy', 'Deploy the service to a region', async (a) => {
        if (a.region !== 'eu') throw new Error(`region ${String(a.region)} is not allowed by the data-residency policy`);
        return { deployed: true, region: 'eu' };
      }),
    ],
    scripts: {
      slm: [
        (req) => (advised(req) ? toolCall('deploy', { region: 'eu' }) : toolCall('deploy', { region: 'us' })),
        (req) => (advised(req) ? toolCall('deploy', { region: 'eu' }) : toolCall('deploy', { region: 'us' })),
        (req) => (sawObservation(req, /deployed/) ? final('Deployed to eu.') : advised(req) ? toolCall('deploy', { region: 'eu' }) : toolCall('deploy', { region: 'us' })),
        (req) => (sawObservation(req, /deployed/) ? final('Deployed to eu.') : toolCall('deploy', { region: 'us' })),
      ],
      llm: [
        (req) => (isConsult(req) ? 'Use region "eu": the residency policy only allows EU regions for this service.' : toolCall('deploy', { region: 'eu' })),
        (req) => (isConsult(req) ? 'Use region "eu".' : sawObservation(req, /deployed/) ? final('Deployed to eu.') : toolCall('deploy', { region: 'eu' })),
        (req) => (sawObservation(req, /deployed/) ? final('Deployed to eu.') : toolCall('deploy', { region: 'eu' })),
      ],
    },
    verify: r => /eu/.test(r.result ?? '') && r.stepResults.some(s => s.toolName === 'deploy' && s.success),
  },

  // 4. Beyond the SLM: it gives up; the LLM must take over from the state.
  {
    id: 'needs-handoff',
    description: 'Analyze the race condition in the token refresh path and implement a fix.',
    complexity: 'high',
    tools: () => [
      tool('read_code', 'Read the refresh path', async () => ({ code: 'async refresh() { token = await fetchToken(); }' })),
      tool('write_patch', 'Apply a patch', async (a) => (/lock|mutex/.test(String(a.patch ?? '')) ? { applied: true } : (() => { throw new Error('patch does not address the race'); })())),
    ],
    scripts: {
      slm: [
        toolCall('read_code', { path: 'auth/refresh.ts' }),
        giveUp('I cannot determine a safe synchronization strategy for this race.'),
        giveUp('Still unsure.'),
      ],
      llm: [
        (req) => (handedOff(req) ? toolCall('write_patch', { patch: 'wrap refresh() in a mutex' }) : toolCall('read_code', { path: 'auth/refresh.ts' })),
        (req) => (sawObservation(req, /applied/) ? final('Serialized refresh() with a mutex.') : toolCall('write_patch', { patch: 'wrap refresh() in a mutex' })),
        final('Serialized refresh() with a mutex.'),
      ],
    },
    verify: r => r.stepResults.some(s => s.toolName === 'write_patch' && s.success),
  },

  // 5. Flaky environment: the SLM would have succeeded on its own with one more retry.
  //    An escalation here is a false positive — this is what precision measures.
  {
    id: 'flaky-retry',
    description: 'Fetch the metrics endpoint and summarize the p95 latency.',
    complexity: 'low',
    tools: () => {
      let failures = 2;
      return [tool('http_fetch', 'Fetch a URL', async () => {
        if (failures > 0) { failures--; throw new Error('ETIMEDOUT fetching https://metrics.local/p95'); }
        return { p95Ms: 212 };
      })];
    },
    scripts: {
      slm: [
        toolCall('http_fetch', { url: 'https://metrics.local/p95' }),
        toolCall('http_fetch', { url: 'https://metrics.local/p95' }),
        toolCall('http_fetch', { url: 'https://metrics.local/p95' }),
        (req) => (sawObservation(req, /p95Ms/) ? final('p95 latency is 212 ms.') : toolCall('http_fetch', { url: 'https://metrics.local/p95' })),
        final('p95 latency is 212 ms.'),
      ],
      llm: [
        (req) => (isConsult(req)
          ? 'Retry the request; the endpoint is flaky but recovers within a couple of attempts.'
          : sawObservation(req, /p95Ms/) ? final('p95 latency is 212 ms.') : toolCall('http_fetch', { url: 'https://metrics.local/p95' })),
      ],
    },
    verify: r => /212/.test(r.result ?? ''),
  },

  // 6. Impossible with the available tools: every strategy should abort cheaply.
  {
    id: 'impossible',
    description: 'Restart the production database cluster.',
    complexity: 'high',
    tools: () => [echoTool()],
    scripts: {
      slm: [toolCall('restart_cluster', { cluster: 'prod' }), toolCall('restart_cluster', { cluster: 'prod' })],
      llm: [toolCall('restart_cluster', { cluster: 'prod' }), toolCall('restart_cluster', { cluster: 'prod' })],
    },
    verify: () => false,
  },
];

/** Build a scripted two-tier provider for one workload run. */
export function scriptedProvider(scripts: { slm: ScriptEntry[]; llm: ScriptEntry[] }) {
  const idx = { slm: 0, llm: 0 };
  const cost = { slm: 0.0002, llm: 0.004 };
  const tokens = { slm: 150, llm: 400 };
  return {
    name: 'ollama' as const,
    supportedTiers: ['slm', 'llm'],
    isAvailable: async () => true,
    listModels: async () => [
      { id: 'bench-slm', name: 'Bench SLM', tier: 'slm', contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
      { id: 'bench-llm', name: 'Bench LLM', tier: 'llm', contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
    ],
    estimateCost: (_n: number, model: string) => (model === 'bench-llm' ? 0.01 : 0.0005),
    chat: async (req: ModelRequest) => {
      const tier = req.tier === 'llm' ? 'llm' : 'slm';
      const list = scripts[tier];
      const entry = list[Math.min(idx[tier], list.length - 1)];
      const content = typeof entry === 'function' ? entry(req, idx[tier]) : (entry ?? '{}');
      idx[tier]++;
      await new Promise(r => setTimeout(r, tier === 'llm' ? 8 : 2));
      return {
        model: tier === 'llm' ? 'bench-llm' : 'bench-slm',
        provider: 'ollama' as const,
        tier: req.tier,
        content,
        tokenUsage: { promptTokens: Math.floor(tokens[tier] * 0.7), completionTokens: Math.ceil(tokens[tier] * 0.3), totalTokens: tokens[tier] },
        latencyMs: tier === 'llm' ? 8 : 2,
        costUsd: cost[tier],
        finishReason: 'stop' as const,
      };
    },
    chatStream: async function* (req: ModelRequest) {
      const res = await this.chat(req);
      yield { content: res.content, done: false };
      yield { content: '', done: true, tokenUsage: res.tokenUsage, finishReason: 'stop' as const };
    },
  };
}
