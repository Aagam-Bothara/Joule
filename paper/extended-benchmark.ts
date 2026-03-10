/**
 * Extended Benchmark: Joule vs CrewAI (Comprehensive)
 * =====================================================
 * 30 tasks across 5 categories, 3 runs each for statistical significance.
 * Focuses on scenarios where runtime guardrails matter:
 *   - Tool-heavy multi-step tasks
 *   - Budget-constrained execution
 *   - Tasks that benefit from planning
 *   - Long-form generation
 *
 * Usage:
 *   npx tsx paper/extended-benchmark.ts                    # Full suite
 *   npx tsx paper/extended-benchmark.ts --category=tools   # Single category
 *   npx tsx paper/extended-benchmark.ts --runs=1           # Quick run
 *   npx tsx paper/extended-benchmark.ts --json
 */

import { Joule } from '@joule/core';
import { OpenAIProvider } from '@joule/models';
import type { Task } from '@joule/shared';
import { z } from 'zod';
import * as fs from 'fs';

// ── Extended Task Set (30 tasks, 5 categories) ─────────────────────────────

interface BenchTask {
  id: string;
  description: string;
  complexity: 'low' | 'medium' | 'high';
  category: string;
  tools: string[];
  expectedSteps: number; // Approximate expected tool calls
}

const TASKS: BenchTask[] = [
  // ── Category 1: Simple Knowledge (5 tasks) — baseline overhead measurement
  { id: 'k1', description: "What is the capital of France? Answer in one sentence.", complexity: 'low', category: 'knowledge', tools: [], expectedSteps: 0 },
  { id: 'k2', description: "Convert 72 degrees Fahrenheit to Celsius. Show only the result.", complexity: 'low', category: 'knowledge', tools: [], expectedSteps: 0 },
  { id: 'k3', description: "List the 3 primary colors. One word each, comma separated.", complexity: 'low', category: 'knowledge', tools: [], expectedSteps: 0 },
  { id: 'k4', description: "What is the time complexity of binary search?", complexity: 'low', category: 'knowledge', tools: [], expectedSteps: 0 },
  { id: 'k5', description: "Name the HTTP status code for 'Not Found'.", complexity: 'low', category: 'knowledge', tools: [], expectedSteps: 0 },

  // ── Category 2: Reasoning (5 tasks) — medium complexity, no tools
  { id: 'r1', description: "Explain the difference between TCP and UDP networking protocols. Include 2-3 practical use cases for each.", complexity: 'medium', category: 'reasoning', tools: [], expectedSteps: 0 },
  { id: 'r2', description: "Compare REST vs GraphQL APIs across 5 dimensions: flexibility, caching, versioning, learning curve, and tooling.", complexity: 'medium', category: 'reasoning', tools: [], expectedSteps: 0 },
  { id: 'r3', description: "Explain the CAP theorem. For each pair (CP, AP, CA), give a real-world database example and explain the trade-off.", complexity: 'medium', category: 'reasoning', tools: [], expectedSteps: 0 },
  { id: 'r4', description: "Compare event-driven architecture vs request-response architecture. When should you use each? Give 3 examples per pattern.", complexity: 'medium', category: 'reasoning', tools: [], expectedSteps: 0 },
  { id: 'r5', description: "Explain how consistent hashing works. Why is it better than modulo hashing for distributed systems? Include a concrete example with 5 nodes.", complexity: 'medium', category: 'reasoning', tools: [], expectedSteps: 0 },

  // ── Category 3: Tool-Heavy (8 tasks) — where planning overhead pays off
  { id: 't1', description: "Search the web for the latest trends in AI agent frameworks in 2025, then analyze the top 3 by maturity, community size, and features.", complexity: 'medium', category: 'tools', tools: ['search_web', 'analyze_data'], expectedSteps: 2 },
  { id: 't2', description: "Analyze this sales data: Q1=$120K, Q2=$145K, Q3=$98K, Q4=$167K. Calculate growth rates, identify the worst quarter, and predict Q1 next year using linear regression.", complexity: 'medium', category: 'tools', tools: ['analyze_data'], expectedSteps: 1 },
  { id: 't3', description: "Search for information about Kubernetes vs Docker Swarm, analyze the comparison data, and write a decision framework report for a startup choosing between them.", complexity: 'high', category: 'tools', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 3 },
  { id: 't4', description: "Research the top 5 vector databases (Pinecone, Weaviate, Milvus, Qdrant, ChromaDB). For each, search for benchmarks, analyze performance data, and write a comparative report.", complexity: 'high', category: 'tools', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 7 },
  { id: 't5', description: "Search for recent developments in WebAssembly (WASM). Analyze adoption metrics across browsers and server runtimes. Write a report with timeline and recommendations.", complexity: 'high', category: 'tools', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 4 },
  { id: 't6', description: "Research the energy consumption of large language models. Search for data from at least 3 sources, analyze the numbers, and write a sustainability report.", complexity: 'high', category: 'tools', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 5 },
  { id: 't7', description: "Search for the latest OWASP Top 10 vulnerabilities. For each vulnerability, search for a real-world example, analyze the attack pattern, and compile into a security brief.", complexity: 'high', category: 'tools', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 12 },
  { id: 't8', description: "Research microservices observability best practices. Search for OpenTelemetry, Jaeger, and Grafana docs. Analyze trace-based debugging approaches. Write an implementation guide.", complexity: 'high', category: 'tools', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 5 },

  // ── Category 4: Long-Form Generation (6 tasks) — token-heavy outputs
  { id: 'g1', description: "Write a comprehensive technical design document for a distributed rate limiter that works across 3 data centers. Include: architecture diagram description, algorithm choices (token bucket vs sliding window), consistency model, failure handling, and API design.", complexity: 'high', category: 'generation', tools: [], expectedSteps: 0 },
  { id: 'g2', description: "Compare and contrast microservices vs monolithic architectures across 8 dimensions: scalability, deployment complexity, development speed, debugging difficulty, cost, team structure requirements, data consistency, and technology lock-in. Provide a decision framework with specific thresholds.", complexity: 'high', category: 'generation', tools: [], expectedSteps: 0 },
  { id: 'g3', description: "Write a complete technical RFC for adding real-time collaboration to a document editor. Cover: conflict resolution (CRDTs vs OT), network protocol, offline support, cursor presence, and undo/redo across users.", complexity: 'high', category: 'generation', tools: [], expectedSteps: 0 },
  { id: 'g4', description: "Design a complete CI/CD pipeline for a monorepo with 5 services (2 Python, 2 Node.js, 1 Go). Include: build optimization, test parallelization, canary deployments, rollback strategy, and secret management.", complexity: 'high', category: 'generation', tools: [], expectedSteps: 0 },
  { id: 'g5', description: "Write a comprehensive guide to database indexing strategies. Cover: B-tree, hash, GIN, GiST, BRIN indexes. For each: when to use, performance characteristics, storage overhead, and a concrete PostgreSQL example.", complexity: 'high', category: 'generation', tools: [], expectedSteps: 0 },
  { id: 'g6', description: "Design an authentication and authorization system for a multi-tenant SaaS platform. Cover: OAuth 2.0 + OIDC flows, RBAC vs ABAC, token management, session handling, and audit logging. Include sequence diagrams described in text.", complexity: 'high', category: 'generation', tools: [], expectedSteps: 0 },

  // ── Category 5: Multi-Step Analysis (6 tasks) — planning-intensive
  { id: 'm1', description: "Research quantum computing's impact on cryptography. Step 1: Search for current quantum capabilities. Step 2: Analyze which encryption algorithms are vulnerable. Step 3: Search for post-quantum alternatives. Step 4: Write a migration timeline report.", complexity: 'high', category: 'multi-step', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 6 },
  { id: 'm2', description: "Conduct a competitive analysis of cloud providers. Step 1: Search for AWS, Azure, GCP pricing for compute. Step 2: Search for their AI/ML service offerings. Step 3: Analyze cost differences. Step 4: Write a recommendation report for a mid-size company.", complexity: 'high', category: 'multi-step', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 6 },
  { id: 'm3', description: "Evaluate programming language trends for backend development. Step 1: Search for 2024-2025 usage statistics. Step 2: Search for performance benchmarks. Step 3: Analyze hiring market data. Step 4: Write a technology radar report.", complexity: 'high', category: 'multi-step', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 6 },
  { id: 'm4', description: "Research the state of edge computing. Step 1: Search for edge vs cloud latency benchmarks. Step 2: Search for major providers (Cloudflare, Fastly, AWS Lambda@Edge). Step 3: Analyze use cases where edge wins. Step 4: Write an architectural decision record.", complexity: 'high', category: 'multi-step', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 6 },
  { id: 'm5', description: "Analyze the impact of AI on software testing. Step 1: Search for AI testing tools. Step 2: Search for case studies of AI-assisted testing. Step 3: Analyze defect detection rates vs manual testing. Step 4: Write a transition roadmap for a QA team.", complexity: 'high', category: 'multi-step', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 6 },
  { id: 'm6', description: "Research zero-trust security architecture. Step 1: Search for NIST zero-trust framework. Step 2: Search for implementation case studies at large companies. Step 3: Analyze common failure patterns. Step 4: Write an implementation checklist for a Fortune 500 company.", complexity: 'high', category: 'multi-step', tools: ['search_web', 'analyze_data', 'write_report'], expectedSteps: 6 },
];

// ── Measurement Types ──────────────────────────────────────────────────────

interface TaskMeasurement {
  taskId: string;
  category: string;
  complexity: string;
  run: number;
  status: string;
  durationMs: number;
  tokensTotal: number;
  costUsd: number;
  toolCalls: number;
  escalations: number;
  steps: number;
  error: string | null;
}

interface CategorySummary {
  category: string;
  taskCount: number;
  totalRuns: number;
  completed: number;
  successRate: number;
  avgCostUsd: number;
  avgTokens: number;
  avgDurationMs: number;
  avgToolCalls: number;
  avgSteps: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

// ── Tool Implementations ───────────────────────────────────────────────────

function registerTools(joule: Joule) {
  joule.registerTool({
    name: 'search_web',
    description: 'Search the web for information on a given query',
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.any(),
    execute: async (args: any) => ({
      results: [
        { title: `Result 1: ${args.query}`, snippet: `Comprehensive information about ${args.query} from authoritative sources. Key findings include recent developments and expert analysis.` },
        { title: `Result 2: ${args.query}`, snippet: `Recent data and benchmarks regarding ${args.query}. Statistical analysis shows significant trends.` },
        { title: `Result 3: ${args.query}`, snippet: `Expert opinions and industry reports about ${args.query}. Multiple perspectives from leading practitioners.` },
      ],
    }),
  });

  joule.registerTool({
    name: 'analyze_data',
    description: 'Analyze a dataset and compute key metrics including trends, statistics, and comparisons',
    inputSchema: z.object({ data: z.string(), metrics: z.array(z.string()).optional() }),
    outputSchema: z.any(),
    execute: async (args: any) => ({
      summary: `Analysis of: ${String(args.data).slice(0, 100)}`,
      metrics: { mean: 132.5, median: 128.0, std_dev: 25.3, trend: 'positive', confidence: 0.87 },
      insights: ['Upward trend detected', 'Q3 shows seasonal dip', 'Growth rate accelerating'],
      timestamp: new Date().toISOString(),
    }),
  });

  joule.registerTool({
    name: 'write_report',
    description: 'Write and save a structured report with title, sections, and findings',
    inputSchema: z.object({ title: z.string(), sections: z.array(z.string()).optional() }),
    outputSchema: z.any(),
    execute: async (args: any) => ({
      saved: true,
      title: args.title,
      sectionCount: args.sections?.length ?? 4,
      wordCount: 1500 + Math.floor(Math.random() * 500),
      format: 'markdown',
    }),
  });
}

// ── Percentile Calculation ─────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const runsPerTask = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] || '3');
  const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
  const jsonOutput = args.includes('--json');
  const budgetPreset = args.find(a => a.startsWith('--budget='))?.split('=')[1] || 'high';

  const apiKey = process.env.OPENAI_API_KEY || process.env.JOULE_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY not set.');
    process.exit(1);
  }

  let tasks = TASKS;
  if (categoryFilter) {
    tasks = TASKS.filter(t => t.category === categoryFilter);
    if (tasks.length === 0) {
      console.error(`No tasks in category '${categoryFilter}'. Available: knowledge, reasoning, tools, generation, multi-step`);
      process.exit(1);
    }
  }

  const totalRuns = tasks.length * runsPerTask;
  console.log('\n' + '═'.repeat(70));
  console.log('  JOULE EXTENDED BENCHMARK');
  console.log(`  Tasks: ${tasks.length} | Runs/task: ${runsPerTask} | Total: ${totalRuns}`);
  console.log(`  Categories: ${[...new Set(tasks.map(t => t.category))].join(', ')}`);
  console.log(`  Budget: ${budgetPreset} | Provider: OpenAI gpt-4o-mini`);
  console.log('  WARNING: This will make real API calls.');
  console.log('═'.repeat(70) + '\n');

  const measurements: TaskMeasurement[] = [];
  let completedCount = 0;

  for (const task of tasks) {
    for (let run = 1; run <= runsPerTask; run++) {
      completedCount++;
      process.stdout.write(`  [${completedCount}/${totalRuns}] ${task.category}/${task.id} run ${run}...`);

      // Fresh Joule instance per run
      const joule = new Joule({
        defaultProvider: 'openai',
        routing: {
          strategy: 'adaptive',
          defaultTier: 'slm',
          escalationThreshold: 0.6,
          maxReplanDepth: 1,
          unifiedPlanning: true,
        },
        governance: { enabled: false },
        budgetPreset: budgetPreset as any,
      } as any);
      await joule.initialize();
      joule.providers.register(new OpenAIProvider({ apiKey: apiKey! }) as any);
      registerTools(joule);

      const taskObj: Task = {
        id: `ext-${task.id}-r${run}`,
        description: task.description,
        budget: budgetPreset as any,
        tools: task.tools,
        createdAt: new Date().toISOString(),
      };

      const start = performance.now();
      let m: TaskMeasurement;

      try {
        const result = await joule.execute(taskObj);
        const durationMs = Math.round(performance.now() - start);
        const bu = result.budgetUsed;

        m = {
          taskId: task.id,
          category: task.category,
          complexity: task.complexity,
          run,
          status: result.status,
          durationMs,
          tokensTotal: bu?.tokensUsed ?? 0,
          costUsd: bu?.costUsd ?? 0,
          toolCalls: bu?.toolCallsUsed ?? 0,
          escalations: bu?.escalationsUsed ?? 0,
          steps: result.stepResults?.length ?? 0,
          error: null,
        };
      } catch (err: any) {
        m = {
          taskId: task.id,
          category: task.category,
          complexity: task.complexity,
          run,
          status: 'error',
          durationMs: Math.round(performance.now() - start),
          tokensTotal: 0,
          costUsd: 0,
          toolCalls: 0,
          escalations: 0,
          steps: 0,
          error: String(err.message).slice(0, 200),
        };
      }

      await joule.shutdown();
      measurements.push(m);

      const icon = m.status === 'completed' ? '✓' : m.status === 'budget_exhausted' ? '⚠' : '✗';
      console.log(` [${icon}] ${m.status} $${m.costUsd.toFixed(4)} / ${m.tokensTotal} tok / ${m.durationMs}ms`);
    }
  }

  // ── Aggregate by Category ──────────────────────────────────────────────

  const categories = [...new Set(tasks.map(t => t.category))];
  const categorySummaries: CategorySummary[] = categories.map(cat => {
    const catMeasurements = measurements.filter(m => m.category === cat);
    const completed = catMeasurements.filter(m => m.status === 'completed');
    const durations = completed.map(m => m.durationMs);

    return {
      category: cat,
      taskCount: tasks.filter(t => t.category === cat).length,
      totalRuns: catMeasurements.length,
      completed: completed.length,
      successRate: catMeasurements.length > 0 ? completed.length / catMeasurements.length * 100 : 0,
      avgCostUsd: completed.length > 0 ? completed.reduce((s, m) => s + m.costUsd, 0) / completed.length : 0,
      avgTokens: completed.length > 0 ? completed.reduce((s, m) => s + m.tokensTotal, 0) / completed.length : 0,
      avgDurationMs: completed.length > 0 ? completed.reduce((s, m) => s + m.durationMs, 0) / completed.length : 0,
      avgToolCalls: completed.length > 0 ? completed.reduce((s, m) => s + m.toolCalls, 0) / completed.length : 0,
      avgSteps: completed.length > 0 ? completed.reduce((s, m) => s + m.steps, 0) / completed.length : 0,
      p50DurationMs: durations.length > 0 ? percentile(durations, 50) : 0,
      p95DurationMs: durations.length > 0 ? percentile(durations, 95) : 0,
    };
  });

  // ── Overall Summary ──────────────────────────────────────────────────────

  const allCompleted = measurements.filter(m => m.status === 'completed');
  const allExhausted = measurements.filter(m => m.status === 'budget_exhausted');
  const overall = {
    totalTasks: tasks.length,
    totalRuns: measurements.length,
    runsPerTask,
    completed: allCompleted.length,
    budgetExhausted: allExhausted.length,
    failed: measurements.length - allCompleted.length - allExhausted.length,
    successRate: measurements.length > 0 ? allCompleted.length / measurements.length * 100 : 0,
    totalCost: allCompleted.reduce((s, m) => s + m.costUsd, 0),
    avgCostPerTask: allCompleted.length > 0 ? allCompleted.reduce((s, m) => s + m.costUsd, 0) / allCompleted.length : 0,
    totalTokens: allCompleted.reduce((s, m) => s + m.tokensTotal, 0),
    avgTokensPerTask: allCompleted.length > 0 ? allCompleted.reduce((s, m) => s + m.tokensTotal, 0) / allCompleted.length : 0,
    avgDurationMs: allCompleted.length > 0 ? allCompleted.reduce((s, m) => s + m.durationMs, 0) / allCompleted.length : 0,
    totalToolCalls: allCompleted.reduce((s, m) => s + m.toolCalls, 0),
    totalEscalations: allCompleted.reduce((s, m) => s + m.escalations, 0),
    p50DurationMs: percentile(allCompleted.map(m => m.durationMs), 50),
    p95DurationMs: percentile(allCompleted.map(m => m.durationMs), 95),
  };

  // ── Output ────────────────────────────────────────────────────────────────

  if (!jsonOutput) {
    console.log('\n' + '═'.repeat(70));
    console.log('  EXTENDED BENCHMARK RESULTS');
    console.log('═'.repeat(70));

    console.log(`\n  Total Runs: ${overall.totalRuns} (${overall.totalTasks} tasks × ${runsPerTask} runs)`);
    console.log(`  Completed: ${overall.completed} (${overall.successRate.toFixed(1)}%)`);
    console.log(`  Budget Exhausted: ${overall.budgetExhausted}`);
    console.log(`  Failed: ${overall.failed}`);
    console.log(`  Total Cost: $${overall.totalCost.toFixed(4)}`);
    console.log(`  Avg Cost/Task: $${overall.avgCostPerTask.toFixed(6)}`);
    console.log(`  Total Tokens: ${overall.totalTokens}`);
    console.log(`  Avg Tokens/Task: ${overall.avgTokensPerTask.toFixed(0)}`);
    console.log(`  Avg Duration: ${overall.avgDurationMs.toFixed(0)}ms`);
    console.log(`  P50 Duration: ${overall.p50DurationMs}ms`);
    console.log(`  P95 Duration: ${overall.p95DurationMs}ms`);
    console.log(`  Total Tool Calls: ${overall.totalToolCalls}`);
    console.log(`  Total Escalations: ${overall.totalEscalations}`);

    console.log('\n── By Category ──────────────────────────────────────────');
    console.log(`  ${'Category'.padEnd(14)} ${'Tasks'.padStart(5)} ${'Runs'.padStart(5)} ${'OK%'.padStart(6)} ${'AvgCost'.padStart(10)} ${'AvgTok'.padStart(8)} ${'AvgMs'.padStart(8)} ${'P50ms'.padStart(8)} ${'P95ms'.padStart(8)} ${'Tools'.padStart(6)}`);
    console.log(`  ${'─'.repeat(14)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(6)}`);
    for (const cs of categorySummaries) {
      console.log(`  ${cs.category.padEnd(14)} ${String(cs.taskCount).padStart(5)} ${String(cs.totalRuns).padStart(5)} ${cs.successRate.toFixed(0).padStart(5)}% $${cs.avgCostUsd.toFixed(4).padStart(9)} ${cs.avgTokens.toFixed(0).padStart(8)} ${cs.avgDurationMs.toFixed(0).padStart(8)} ${cs.p50DurationMs.toFixed(0).padStart(8)} ${cs.p95DurationMs.toFixed(0).padStart(8)} ${cs.avgToolCalls.toFixed(1).padStart(6)}`);
    }

    // Per-task averages
    console.log('\n── Per-Task Averages ──────────────────────────────────────────');
    console.log(`  ${'ID'.padEnd(5)} ${'Category'.padEnd(12)} ${'Cmplx'.padEnd(7)} ${'Status'.padEnd(10)} ${'AvgCost'.padStart(10)} ${'AvgTok'.padStart(8)} ${'AvgMs'.padStart(8)} ${'Tools'.padStart(6)} ${'Steps'.padStart(6)}`);
    console.log(`  ${'─'.repeat(5)} ${'─'.repeat(12)} ${'─'.repeat(7)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(6)}`);
    for (const task of tasks) {
      const tm = measurements.filter(m => m.taskId === task.id);
      const tc = tm.filter(m => m.status === 'completed');
      const sr = tc.length > 0 ? `${tc.length}/${tm.length}` : '0/' + tm.length;
      const avgCost = tc.length > 0 ? tc.reduce((s, m) => s + m.costUsd, 0) / tc.length : 0;
      const avgTok = tc.length > 0 ? tc.reduce((s, m) => s + m.tokensTotal, 0) / tc.length : 0;
      const avgMs = tc.length > 0 ? tc.reduce((s, m) => s + m.durationMs, 0) / tc.length : 0;
      const avgTools = tc.length > 0 ? tc.reduce((s, m) => s + m.toolCalls, 0) / tc.length : 0;
      const avgSteps = tc.length > 0 ? tc.reduce((s, m) => s + m.steps, 0) / tc.length : 0;
      console.log(`  ${task.id.padEnd(5)} ${task.category.padEnd(12)} ${task.complexity.padEnd(7)} ${sr.padEnd(10)} $${avgCost.toFixed(4).padStart(9)} ${avgTok.toFixed(0).padStart(8)} ${avgMs.toFixed(0).padStart(8)} ${avgTools.toFixed(1).padStart(6)} ${avgSteps.toFixed(1).padStart(6)}`);
    }
  }

  // Save results
  const results = {
    framework: 'joule',
    model: 'gpt-4o-mini',
    provider: 'openai',
    budgetPreset,
    runsPerTask,
    timestamp: new Date().toISOString(),
    overall,
    categorySummaries,
    measurements,
  };

  fs.mkdirSync('paper/results', { recursive: true });
  fs.writeFileSync('paper/results/extended-joule-results.json', JSON.stringify(results, null, 2));
  console.log(`\n  Results saved to paper/results/extended-joule-results.json`);
}

main().catch(console.error);
