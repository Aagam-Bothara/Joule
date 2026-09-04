/**
 * Live workloads — real tasks for real providers. Success here is status-judged
 * unless a `verify` function is given, and the report marks it as such.
 */

import type { Workload } from '../types.js';

export const LIVE_WORKLOADS: Workload[] = [
  { id: 'explain-concept', complexity: 'low', description: 'Explain what a mutex is in two sentences.' },
  { id: 'list-items', complexity: 'low', description: 'List five common causes of flaky integration tests.' },
  { id: 'summarize', complexity: 'low', description: 'Summarize the trade-offs between optimistic and pessimistic locking in one paragraph.' },
  { id: 'compare', complexity: 'medium', description: 'Compare Redis and Memcached for session storage and recommend one for a 10k-user SaaS app.' },
  {
    id: 'write-and-verify-file',
    complexity: 'medium',
    description: 'Write a file named joule-bench.txt containing the line "hello from joule" in the current directory, then read it back to confirm.',
    verify: r => r.stepResults.some(s => s.toolName === 'file_read' && s.success && /hello from joule/i.test(JSON.stringify(s.output ?? ''))),
  },
  {
    id: 'shell-check',
    complexity: 'medium',
    description: 'Use the shell to print the current Node.js version and report it.',
    verify: r => r.stepResults.some(s => s.toolName === 'shell_exec' && s.success) && /v?\d+\.\d+/.test(r.result ?? ''),
  },
  { id: 'design-system', complexity: 'high', description: 'Design a rate limiter for a public API: pick an algorithm, describe the data model, and explain how it behaves under a burst.' },
  { id: 'debug-plan', complexity: 'high', description: 'A service intermittently returns 401 during concurrent token refreshes. Produce a step-by-step debugging plan and the most likely fix.' },
];
