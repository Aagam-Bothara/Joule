/**
 * Paper Benchmark: Joule (50 tasks, 5 categories)
 * ==================================================
 * Designed for academic paper evaluation with precise per-task metrics.
 *
 * Categories (10 tasks each):
 *   1. Simple Q&A — single-turn, no tools needed
 *   2. Summarization — given a document/text, produce a summary
 *   3. Research — multi-step, needs web search or reasoning
 *   4. Code generation — write a function / debug something
 *   5. Multi-step planning — break down a goal into steps and execute
 *
 * Per task, records metrics:
 *   - prompt_tokens
 *   - completion_tokens
 *   - num_llm_calls
 *   - energy_wh
 *   - task_success (1/0)
 *   - latency_ms
 *   - pruning_total_results, pruning_pruned_count, pruning_repaired_edges, pruning_rate
 *   - quality_score (LLM-as-judge, 1-5)
 *
 * Ablation configurations:
 *   - full          — all mechanisms enabled (default Joule config)
 *   - no-pruning    — dependency pruning disabled
 *   - no-prompt-opt — unified planning disabled
 *   - no-routing    — always use large model (defeats SLM-first)
 *
 * Usage:
 *   npx tsx paper/paper-benchmark.ts
 *   npx tsx paper/paper-benchmark.ts --category=qa
 *   npx tsx paper/paper-benchmark.ts --runs=3
 *   npx tsx paper/paper-benchmark.ts --config=full
 *   npx tsx paper/paper-benchmark.ts --config=no-pruning --runs=5
 */

import { Joule } from '@joule/core';
import { OpenAIProvider } from '@joule/models';
import { estimateEnergy } from '@joule/shared';
import type { Task } from '@joule/shared';
import { z } from 'zod';
import * as fs from 'fs';

// ── Task Definitions (50 tasks, 5 categories × 10) ──────────────────────────

interface BenchTask {
  id: string;
  description: string;
  category: 'qa' | 'summarization' | 'research' | 'code_generation' | 'multi_step';
  tools: string[];
}

const TASKS: BenchTask[] = [
  // ── Category 1: Simple Q&A (10 tasks) ──────────────────────────────────────
  { id: 'qa01', category: 'qa', tools: [],
    description: "What is the capital of France? Answer in one sentence." },
  { id: 'qa02', category: 'qa', tools: [],
    description: "Convert 72 degrees Fahrenheit to Celsius. Show only the result." },
  { id: 'qa03', category: 'qa', tools: [],
    description: "List the 3 primary colors. One word each, comma separated." },
  { id: 'qa04', category: 'qa', tools: [],
    description: "What is the time complexity of binary search?" },
  { id: 'qa05', category: 'qa', tools: [],
    description: "Name the HTTP status code for 'Not Found'." },
  { id: 'qa06', category: 'qa', tools: [],
    description: "What does the acronym REST stand for?" },
  { id: 'qa07', category: 'qa', tools: [],
    description: "How many bits are in a byte?" },
  { id: 'qa08', category: 'qa', tools: [],
    description: "What is the default port for HTTPS?" },
  { id: 'qa09', category: 'qa', tools: [],
    description: "Name the four pillars of object-oriented programming." },
  { id: 'qa10', category: 'qa', tools: [],
    description: "What is the difference between stack and heap memory in one sentence?" },

  // ── Category 2: Summarization (10 tasks) ───────────────────────────────────
  { id: 'sum01', category: 'summarization', tools: [],
    description: "Summarize the key concepts of the CAP theorem in 3 bullet points." },
  { id: 'sum02', category: 'summarization', tools: [],
    description: "Summarize the differences between TCP and UDP in a short paragraph (50-80 words)." },
  { id: 'sum03', category: 'summarization', tools: [],
    description: "Summarize the SOLID principles of software design. One sentence per principle." },
  { id: 'sum04', category: 'summarization', tools: [],
    description: "Summarize how garbage collection works in Java in 3-4 sentences for a beginner." },
  { id: 'sum05', category: 'summarization', tools: [],
    description: "Summarize the main differences between SQL and NoSQL databases in a comparison table format (text-based)." },
  { id: 'sum06', category: 'summarization', tools: [],
    description: "Summarize the key features of Docker containers vs virtual machines. Keep it under 100 words." },
  { id: 'sum07', category: 'summarization', tools: [],
    description: "Summarize the OSI model's 7 layers. One line per layer with its primary function." },
  { id: 'sum08', category: 'summarization', tools: [],
    description: "Summarize the benefits and drawbacks of microservices architecture in 4-5 bullet points." },
  { id: 'sum09', category: 'summarization', tools: [],
    description: "Summarize how HTTPS/TLS handshake works in 3-4 simple steps." },
  { id: 'sum10', category: 'summarization', tools: [],
    description: "Summarize the key differences between Git merge and Git rebase. When should you use each?" },

  // ── Category 3: Research (10 tasks) ────────────────────────────────────────
  { id: 'res01', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Search for the latest trends in AI agent frameworks in 2025, then analyze the top 3 by maturity, community size, and features." },
  { id: 'res02', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Research the current state of WebAssembly adoption. Search for browser support data and server-side usage statistics. Analyze the growth trend." },
  { id: 'res03', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Search for the top 5 vector databases (Pinecone, Weaviate, Milvus, Qdrant, ChromaDB) and analyze their performance benchmarks." },
  { id: 'res04', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Research the energy consumption of large language models. Search for data from at least 3 sources and analyze the numbers." },
  { id: 'res05', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Search for Kubernetes vs Docker Swarm comparison data and analyze which is better for small teams vs enterprise." },
  { id: 'res06', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Research the current state of quantum computing. Search for recent breakthroughs and analyze which encryption algorithms are at risk." },
  { id: 'res07', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Search for the latest OWASP Top 10 vulnerabilities and analyze the most common attack patterns in 2024-2025." },
  { id: 'res08', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Research edge computing vs cloud computing. Search for latency benchmarks and analyze use cases where edge wins." },
  { id: 'res09', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Search for TypeScript vs Rust for backend development. Analyze performance, developer experience, and ecosystem maturity." },
  { id: 'res10', category: 'research', tools: ['search_web', 'analyze_data'],
    description: "Research the impact of AI on software testing. Search for AI testing tools and analyze defect detection rates vs manual testing." },

  // ── Category 4: Code Generation (10 tasks) ────────────────────────────────
  { id: 'code01', category: 'code_generation', tools: [],
    description: "Write a TypeScript function that checks if a string is a valid palindrome, ignoring spaces and punctuation. Include type annotations." },
  { id: 'code02', category: 'code_generation', tools: [],
    description: "Write a Python function that implements binary search on a sorted list. Return the index or -1 if not found. Include docstring." },
  { id: 'code03', category: 'code_generation', tools: [],
    description: "Write a JavaScript debounce function that delays invoking a callback until after N milliseconds have passed since the last invocation." },
  { id: 'code04', category: 'code_generation', tools: [],
    description: "Write a SQL query that finds the top 5 customers by total order value, joining the customers and orders tables. Include the customer name, email, and total spent." },
  { id: 'code05', category: 'code_generation', tools: [],
    description: "Write a TypeScript generic function `groupBy<T>(items: T[], key: keyof T): Record<string, T[]>` that groups array items by a given key." },
  { id: 'code06', category: 'code_generation', tools: [],
    description: "Debug this JavaScript code and explain the bug: `function sum(arr) { let total; for (let i = 0; i <= arr.length; i++) { total += arr[i]; } return total; }`" },
  { id: 'code07', category: 'code_generation', tools: [],
    description: "Write a Python class `LRUCache` with `get(key)` and `put(key, value)` methods. Use OrderedDict for O(1) operations. Capacity set in constructor." },
  { id: 'code08', category: 'code_generation', tools: [],
    description: "Write a bash script that monitors a directory for new .csv files and automatically moves them to a processed/ subdirectory after printing their line count." },
  { id: 'code09', category: 'code_generation', tools: [],
    description: "Write a TypeScript function that flattens a deeply nested object into dot-notation keys. Example: {a: {b: {c: 1}}} → {'a.b.c': 1}." },
  { id: 'code10', category: 'code_generation', tools: [],
    description: "Write a React hook `useLocalStorage<T>(key: string, defaultValue: T)` that syncs state with localStorage, handling SSR and JSON serialization." },

  // ── Category 5: Multi-Step Planning (10 tasks) ─────────────────────────────
  { id: 'ms01', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Research quantum computing's impact on cryptography. Step 1: Search for current quantum capabilities. Step 2: Analyze which encryption algorithms are vulnerable. Step 3: Search for post-quantum alternatives. Step 4: Write a migration timeline report." },
  { id: 'ms02', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Conduct a competitive analysis of cloud providers. Step 1: Search for AWS, Azure, GCP pricing for compute. Step 2: Search for their AI/ML service offerings. Step 3: Analyze cost differences. Step 4: Write a recommendation report." },
  { id: 'ms03', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Evaluate programming language trends for backend development. Step 1: Search for 2024-2025 usage statistics. Step 2: Search for performance benchmarks. Step 3: Analyze hiring market data. Step 4: Write a technology radar report." },
  { id: 'ms04', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Research the state of edge computing. Step 1: Search for edge vs cloud latency benchmarks. Step 2: Search for major providers (Cloudflare, Fastly, Lambda@Edge). Step 3: Analyze use cases. Step 4: Write an architectural decision record." },
  { id: 'ms05', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Analyze the impact of AI on software testing. Step 1: Search for AI testing tools. Step 2: Search for case studies. Step 3: Analyze defect detection rates vs manual testing. Step 4: Write a transition roadmap for a QA team." },
  { id: 'ms06', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Research zero-trust security architecture. Step 1: Search for NIST zero-trust framework. Step 2: Search for implementation case studies. Step 3: Analyze common failure patterns. Step 4: Write an implementation checklist." },
  { id: 'ms07', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Evaluate serverless vs containerized architectures. Step 1: Search for cost comparison data. Step 2: Search for cold start benchmarks. Step 3: Analyze scaling patterns. Step 4: Write a decision framework report." },
  { id: 'ms08', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Research API gateway patterns. Step 1: Search for Kong, AWS API Gateway, Envoy features. Step 2: Search for performance benchmarks. Step 3: Analyze rate limiting approaches. Step 4: Write a comparison report." },
  { id: 'ms09', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Analyze database migration strategies. Step 1: Search for blue-green deployment patterns. Step 2: Search for schema versioning tools (Flyway, Liquibase). Step 3: Analyze rollback strategies. Step 4: Write a best practices guide." },
  { id: 'ms10', category: 'multi_step', tools: ['search_web', 'analyze_data', 'write_report'],
    description: "Research observability best practices for microservices. Step 1: Search for OpenTelemetry docs. Step 2: Search for distributed tracing case studies. Step 3: Analyze alert fatigue patterns. Step 4: Write an implementation guide." },
];

// ── Ablation Configurations ─────────────────────────────────────────────────

type AblationConfig = 'full' | 'no-pruning' | 'no-prompt-opt' | 'no-routing' | 'path-full' | 'path-classifier-only';

const ABLATION_CONFIGS: AblationConfig[] = ['full', 'no-pruning', 'no-prompt-opt', 'no-routing', 'path-full', 'path-classifier-only'];

function buildJouleConfig(config: AblationConfig, budgetPreset: string): any {
  const base = {
    defaultProvider: 'openai',
    routing: {
      strategy: 'adaptive',
      defaultTier: 'slm',
      escalationThreshold: 0.6,
      maxReplanDepth: 1,
      unifiedPlanning: true,
      enableDependencyPruning: true,
    },
    governance: { enabled: false },
    budgetPreset: budgetPreset as any,
  };

  switch (config) {
    case 'full':
      // All mechanisms enabled — default config
      return base;

    case 'no-pruning':
      return {
        ...base,
        routing: {
          ...base.routing,
          enableDependencyPruning: false,
        },
      };

    case 'no-prompt-opt':
      return {
        ...base,
        routing: {
          ...base.routing,
          unifiedPlanning: false,
        },
      };

    case 'no-routing':
      return {
        ...base,
        routing: {
          ...base.routing,
          defaultTier: 'llm',
        },
      };

    case 'path-full':
      // New system: full execution path selection (P0 cache + P1 direct + P2 templates + P3 chunked + P4 planned)
      return {
        ...base,
        executionPath: { enabled: true, classifierOnly: false },
      };

    case 'path-classifier-only':
      // Ablation: classifier routing only — no P2 templates, no P3 chunked, no P0 cache
      return {
        ...base,
        executionPath: { enabled: true, classifierOnly: true },
      };
  }
}

// ── Measurement Schema ───────────────────────────────────────────────────────

interface PaperMeasurement {
  task_id: string;
  category: string;
  run: number;
  config: AblationConfig;
  prompt_tokens: number;
  completion_tokens: number;
  num_llm_calls: number;
  energy_wh: number;
  task_success: 0 | 1;
  latency_ms: number;
  pruning_total_results: number;
  pruning_pruned_count: number;
  pruning_repaired_edges: number;
  pruning_rate: number;
  quality_score: number;
  // Execution path metrics (new — P0–P5 path selection system)
  execution_path?: number;       // which path was selected (0–5)
  path_confidence?: number;      // classifier confidence (0–1)
  path_from_cache?: boolean;     // whether result came from semantic cache
  template_matched?: string;     // template key if P2 was used
}

interface CategorySummary {
  category: string;
  config: AblationConfig;
  task_count: number;
  total_runs: number;
  success_count: number;
  success_rate: number;
  avg_prompt_tokens: number;
  avg_completion_tokens: number;
  avg_num_llm_calls: number;
  avg_energy_wh: number;
  avg_latency_ms: number;
  stddev_energy_wh: number;
  stddev_latency_ms: number;
  avg_quality_score: number;
  avg_pruning_rate: number;
}

// ── Statistical Helpers ─────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ── Pruning Trace Extraction ────────────────────────────────────────────────

interface PruningMetrics {
  pruning_total_results: number;
  pruning_pruned_count: number;
  pruning_repaired_edges: number;
  pruning_rate: number;
}

function extractPruningMetrics(joule: Joule): PruningMetrics {
  const defaults: PruningMetrics = {
    pruning_total_results: 0,
    pruning_pruned_count: 0,
    pruning_repaired_edges: 0,
    pruning_rate: 0,
  };

  try {
    // The tracer is accessible via joule internals
    const traces = (joule as any).executor?.tracer?.getAllTraces?.() || [];

    let totalResults = 0;
    let prunedCount = 0;
    let repairedEdges = 0;

    for (const trace of traces) {
      if (trace.type === 'dependency_pruning' || trace.event === 'dependency_pruning') {
        totalResults += trace.data?.total_results ?? trace.total_results ?? 0;
        prunedCount += trace.data?.pruned_count ?? trace.pruned_count ?? 0;
        repairedEdges += trace.data?.repaired_edges ?? trace.repaired_edges ?? 0;
      }
    }

    return {
      pruning_total_results: totalResults,
      pruning_pruned_count: prunedCount,
      pruning_repaired_edges: repairedEdges,
      pruning_rate: totalResults > 0 ? prunedCount / totalResults : 0,
    };
  } catch {
    return defaults;
  }
}

// ── Execution Path Trace Extraction ─────────────────────────────────────────

interface PathMetrics {
  execution_path: number;
  path_confidence: number;
  path_from_cache: boolean;
  template_matched?: string;
}

function extractPathMetrics(joule: Joule): PathMetrics {
  const defaults: PathMetrics = {
    execution_path: 4, // default to P4 (planned) if not found
    path_confidence: 0,
    path_from_cache: false,
  };

  try {
    const traces = (joule as any).executor?.tracer?.getAllTraces?.() || [];
    for (const trace of traces) {
      const data = trace.data ?? trace;
      if (data?.type === 'execution_path_selected') {
        return {
          execution_path: data.path ?? 4,
          path_confidence: data.confidence ?? 0,
          path_from_cache: data.fromCache ?? false,
          template_matched: data.template ?? undefined,
        };
      }
    }
    return defaults;
  } catch {
    return defaults;
  }
}

// ── LLM-as-Judge Quality Scoring ────────────────────────────────────────────

async function scoreQuality(
  apiKey: string,
  taskDescription: string,
  responseOutput: string,
): Promise<number> {
  try {
    const qualityPrompt = `Rate the quality of this response on a scale of 1-5.
Task: ${taskDescription}
Response: ${responseOutput}

Respond with ONLY a JSON object: {"score": <1-5>, "reason": "<brief reason>"}`;

    const judgeProvider = new OpenAIProvider({ apiKey });
    const judgeResult = await (judgeProvider as any).chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: qualityPrompt }],
      temperature: 0,
      maxTokens: 150,
    });

    const content = judgeResult?.content ?? judgeResult?.choices?.[0]?.message?.content ?? '';
    const jsonMatch = content.match(/\{[\s\S]*?"score"\s*:\s*(\d)[\s\S]*?\}/);
    if (jsonMatch) {
      const score = parseInt(jsonMatch[1], 10);
      if (score >= 1 && score <= 5) return score;
    }
    return 3; // default to middle score on parse failure
  } catch {
    return 0; // 0 indicates scoring failed
  }
}

// ── Tool Implementations ─────────────────────────────────────────────────────

function registerTools(joule: Joule) {
  joule.registerTool({
    name: 'search_web',
    description: 'Search the web for information on a given query',
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.any(),
    execute: async (args: any) => ({
      results: [
        { title: `Result 1: ${args.query}`, snippet: `Comprehensive information about ${args.query} from authoritative sources.` },
        { title: `Result 2: ${args.query}`, snippet: `Recent data and benchmarks regarding ${args.query}.` },
        { title: `Result 3: ${args.query}`, snippet: `Expert opinions and industry reports about ${args.query}.` },
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
      insights: ['Upward trend detected', 'Seasonal dip in Q3', 'Growth rate accelerating'],
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const runsPerTask = parseInt(args.find(a => a.startsWith('--runs='))?.split('=')[1] || '3');
  const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
  const budgetPreset = args.find(a => a.startsWith('--budget='))?.split('=')[1] || 'high';
  const configFilter = args.find(a => a.startsWith('--config='))?.split('=')[1] as AblationConfig | undefined;

  const apiKey = process.env.OPENAI_API_KEY || process.env.JOULE_OPENAI_API_KEY;
  if (!apiKey) {
    console.error('ERROR: OPENAI_API_KEY or JOULE_OPENAI_API_KEY not set.');
    process.exit(1);
  }

  let tasks = TASKS;
  if (categoryFilter) {
    tasks = TASKS.filter(t => t.category === categoryFilter);
    if (tasks.length === 0) {
      const cats = [...new Set(TASKS.map(t => t.category))].join(', ');
      console.error(`No tasks in category '${categoryFilter}'. Available: ${cats}`);
      process.exit(1);
    }
  }

  // Determine which ablation configs to run
  const configsToRun: AblationConfig[] = configFilter
    ? (ABLATION_CONFIGS.includes(configFilter) ? [configFilter] : (() => {
        console.error(`Invalid config '${configFilter}'. Available: ${ABLATION_CONFIGS.join(', ')}`);
        process.exit(1);
        return []; // unreachable
      })())
    : ABLATION_CONFIGS;

  for (const currentConfig of configsToRun) {
    const totalRuns = tasks.length * runsPerTask;
    console.log('\n' + '='.repeat(70));
    console.log(`  JOULE PAPER BENCHMARK (50-task suite) — config: ${currentConfig}`);
    console.log(`  Tasks: ${tasks.length} | Runs/task: ${runsPerTask} | Total: ${totalRuns}`);
    console.log(`  Categories: ${[...new Set(tasks.map(t => t.category))].join(', ')}`);
    console.log(`  Budget: ${budgetPreset} | Provider: OpenAI gpt-4o-mini`);
    console.log(`  Ablation: ${currentConfig}`);
    console.log('  WARNING: This will make real API calls.');
    console.log('='.repeat(70) + '\n');

    // Track LLM calls via provider wrapper
    let llmCallCount = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    const measurements: PaperMeasurement[] = [];
    let completedCount = 0;

    for (const task of tasks) {
      for (let run = 1; run <= runsPerTask; run++) {
        completedCount++;
        process.stdout.write(`  [${completedCount}/${totalRuns}] ${task.category}/${task.id} run ${run} (${currentConfig})...`);

        // Fresh Joule instance per run with ablation-specific config
        const jouleConfig = buildJouleConfig(currentConfig, budgetPreset);
        const joule = new Joule(jouleConfig);
        await joule.initialize();

        // Wrap provider to count LLM calls and track prompt/completion tokens
        llmCallCount = 0;
        totalPromptTokens = 0;
        totalCompletionTokens = 0;

        const realProvider = new OpenAIProvider({ apiKey: apiKey! }) as any;
        const wrappedProvider = {
          ...realProvider,
          name: realProvider.name,
          supportedTiers: realProvider.supportedTiers,
          isAvailable: realProvider.isAvailable.bind(realProvider),
          listModels: realProvider.listModels.bind(realProvider),
          estimateCost: realProvider.estimateCost.bind(realProvider),
          chat: async (...chatArgs: any[]) => {
            llmCallCount++;
            const result = await realProvider.chat(...chatArgs);
            totalPromptTokens += result.tokenUsage?.promptTokens ?? 0;
            totalCompletionTokens += result.tokenUsage?.completionTokens ?? 0;
            return result;
          },
          chatStream: realProvider.chatStream?.bind(realProvider),
        };
        joule.providers.register(wrappedProvider);
        registerTools(joule);

        const taskObj: Task = {
          id: `paper-${task.id}-r${run}`,
          description: task.description,
          budget: budgetPreset as any,
          tools: task.tools,
          createdAt: new Date().toISOString(),
        };

        const start = performance.now();
        let m: PaperMeasurement;

        try {
          const result = await joule.execute(taskObj);
          const latencyMs = Math.round(performance.now() - start);
          const success = result.status === 'completed' ? 1 : 0;

          // Energy: use Joule's built-in energy model for gpt-4o-mini
          const energyWh = estimateEnergy('gpt-4o-mini', totalPromptTokens, totalCompletionTokens);

          // Extract pruning metrics from traces
          const pruning = extractPruningMetrics(joule);

          // Extract execution path metrics
          const pathMetrics = extractPathMetrics(joule);

          // LLM-as-judge quality scoring (separate call, not counted in task metrics)
          const outputText = typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result ?? '');
          const qualityScore = await scoreQuality(apiKey!, task.description, outputText);

          m = {
            task_id: task.id,
            category: task.category,
            run,
            config: currentConfig,
            prompt_tokens: totalPromptTokens,
            completion_tokens: totalCompletionTokens,
            num_llm_calls: llmCallCount,
            energy_wh: parseFloat(energyWh.toFixed(8)),
            task_success: success as 0 | 1,
            latency_ms: latencyMs,
            pruning_total_results: pruning.pruning_total_results,
            pruning_pruned_count: pruning.pruning_pruned_count,
            pruning_repaired_edges: pruning.pruning_repaired_edges,
            pruning_rate: parseFloat(pruning.pruning_rate.toFixed(4)),
            quality_score: qualityScore,
            execution_path: pathMetrics.execution_path,
            path_confidence: parseFloat(pathMetrics.path_confidence.toFixed(3)),
            path_from_cache: pathMetrics.path_from_cache,
            template_matched: pathMetrics.template_matched,
          };
        } catch (err: any) {
          m = {
            task_id: task.id,
            category: task.category,
            run,
            config: currentConfig,
            prompt_tokens: totalPromptTokens,
            completion_tokens: totalCompletionTokens,
            num_llm_calls: llmCallCount,
            energy_wh: 0,
            task_success: 0,
            latency_ms: Math.round(performance.now() - start),
            pruning_total_results: 0,
            pruning_pruned_count: 0,
            pruning_repaired_edges: 0,
            pruning_rate: 0,
            quality_score: 0,
          };
        }

        await joule.shutdown();
        measurements.push(m);

        const icon = m.task_success ? '+' : 'x';
        const totalTok = m.prompt_tokens + m.completion_tokens;
        const pathLabel = m.path_from_cache ? 'P0(cache)' : `P${m.execution_path ?? 4}`;
        console.log(` [${icon}] ${totalTok} tok (${m.prompt_tokens}p/${m.completion_tokens}c) | ${m.num_llm_calls} calls | ${m.energy_wh.toFixed(6)} Wh | ${m.latency_ms}ms | Q:${m.quality_score} | prune:${(m.pruning_rate * 100).toFixed(1)}% | ${pathLabel}`);
      }

      // Per-task statistical summary across runs
      const taskRuns = measurements.filter(r => r.task_id === task.id);
      if (taskRuns.length > 1) {
        const energies = taskRuns.map(r => r.energy_wh);
        const latencies = taskRuns.map(r => r.latency_ms);
        const qualities = taskRuns.filter(r => r.quality_score > 0).map(r => r.quality_score);
        const pruneRates = taskRuns.map(r => r.pruning_rate);
        console.log(
          `    -> ${task.id} stats (n=${taskRuns.length}): ` +
          `energy ${mean(energies).toFixed(6)}+/-${stddev(energies).toFixed(6)} Wh | ` +
          `latency ${mean(latencies).toFixed(0)}+/-${stddev(latencies).toFixed(0)} ms | ` +
          `quality ${mean(qualities).toFixed(2)} | ` +
          `prune ${(mean(pruneRates) * 100).toFixed(1)}%`
        );
      }
    }

    // ── Aggregate ──────────────────────────────────────────────────────────────

    const categories = [...new Set(tasks.map(t => t.category))];
    const categorySummaries: CategorySummary[] = categories.map(cat => {
      const cm = measurements.filter(m => m.category === cat);
      const successful = cm.filter(m => m.task_success === 1);
      const energyValues = successful.map(m => m.energy_wh);
      const latencyValues = successful.map(m => m.latency_ms);
      const qualityValues = successful.filter(m => m.quality_score > 0).map(m => m.quality_score);
      const pruneValues = cm.map(m => m.pruning_rate);

      return {
        category: cat,
        config: currentConfig,
        task_count: tasks.filter(t => t.category === cat).length,
        total_runs: cm.length,
        success_count: successful.length,
        success_rate: cm.length > 0 ? successful.length / cm.length * 100 : 0,
        avg_prompt_tokens: mean(successful.map(m => m.prompt_tokens)),
        avg_completion_tokens: mean(successful.map(m => m.completion_tokens)),
        avg_num_llm_calls: mean(successful.map(m => m.num_llm_calls)),
        avg_energy_wh: mean(energyValues),
        avg_latency_ms: mean(latencyValues),
        stddev_energy_wh: stddev(energyValues),
        stddev_latency_ms: stddev(latencyValues),
        avg_quality_score: mean(qualityValues),
        avg_pruning_rate: mean(pruneValues),
      };
    });

    const allSuccessful = measurements.filter(m => m.task_success === 1);
    const allEnergies = allSuccessful.map(m => m.energy_wh);
    const allLatencies = allSuccessful.map(m => m.latency_ms);
    const allQualities = allSuccessful.filter(m => m.quality_score > 0).map(m => m.quality_score);
    const allPruneRates = measurements.map(m => m.pruning_rate);

    const overall = {
      config: currentConfig,
      total_tasks: tasks.length,
      total_runs: measurements.length,
      runs_per_task: runsPerTask,
      success_count: allSuccessful.length,
      success_rate: measurements.length > 0 ? allSuccessful.length / measurements.length * 100 : 0,
      total_prompt_tokens: measurements.reduce((s, m) => s + m.prompt_tokens, 0),
      total_completion_tokens: measurements.reduce((s, m) => s + m.completion_tokens, 0),
      avg_prompt_tokens: mean(allSuccessful.map(m => m.prompt_tokens)),
      avg_completion_tokens: mean(allSuccessful.map(m => m.completion_tokens)),
      avg_num_llm_calls: mean(allSuccessful.map(m => m.num_llm_calls)),
      total_energy_wh: measurements.reduce((s, m) => s + m.energy_wh, 0),
      avg_energy_wh: mean(allEnergies),
      stddev_energy_wh: stddev(allEnergies),
      avg_latency_ms: mean(allLatencies),
      stddev_latency_ms: stddev(allLatencies),
      avg_quality_score: mean(allQualities),
      avg_pruning_rate: mean(allPruneRates),
    };

    // ── Console Output ─────────────────────────────────────────────────────────

    console.log('\n' + '='.repeat(70));
    console.log(`  PAPER BENCHMARK RESULTS (JOULE) — config: ${currentConfig}`);
    console.log('='.repeat(70));

    console.log(`\n  Total: ${overall.total_runs} runs (${overall.total_tasks} tasks x ${runsPerTask})`);
    console.log(`  Success: ${overall.success_count}/${overall.total_runs} (${overall.success_rate.toFixed(1)}%)`);
    console.log(`  Avg Prompt Tokens: ${overall.avg_prompt_tokens.toFixed(0)}`);
    console.log(`  Avg Completion Tokens: ${overall.avg_completion_tokens.toFixed(0)}`);
    console.log(`  Avg LLM Calls: ${overall.avg_num_llm_calls.toFixed(1)}`);
    console.log(`  Total Energy: ${overall.total_energy_wh.toFixed(6)} Wh`);
    console.log(`  Avg Energy/Task: ${overall.avg_energy_wh.toFixed(6)} +/- ${overall.stddev_energy_wh.toFixed(6)} Wh`);
    console.log(`  Avg Latency: ${overall.avg_latency_ms.toFixed(0)} +/- ${overall.stddev_latency_ms.toFixed(0)} ms`);
    console.log(`  Avg Quality Score: ${overall.avg_quality_score.toFixed(2)}/5`);
    console.log(`  Avg Pruning Rate: ${(overall.avg_pruning_rate * 100).toFixed(1)}%`);

    console.log('\n-- By Category --');
    console.log(
      `  ${'Category'.padEnd(18)} ${'Tasks'.padStart(5)} ${'OK%'.padStart(6)} ${'AvgEnergy'.padStart(12)} ${'StdEnergy'.padStart(12)}` +
      ` ${'AvgMs'.padStart(8)} ${'StdMs'.padStart(8)} ${'Quality'.padStart(8)} ${'Prune%'.padStart(8)}`
    );
    console.log(
      `  ${'─'.repeat(18)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(12)} ${'─'.repeat(12)}` +
      ` ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`
    );
    for (const cs of categorySummaries) {
      console.log(
        `  ${cs.category.padEnd(18)} ${String(cs.task_count).padStart(5)} ${cs.success_rate.toFixed(0).padStart(5)}%` +
        ` ${cs.avg_energy_wh.toFixed(6).padStart(12)} ${cs.stddev_energy_wh.toFixed(6).padStart(12)}` +
        ` ${cs.avg_latency_ms.toFixed(0).padStart(8)} ${cs.stddev_latency_ms.toFixed(0).padStart(8)}` +
        ` ${cs.avg_quality_score.toFixed(2).padStart(8)} ${(cs.avg_pruning_rate * 100).toFixed(1).padStart(7)}%`
      );
    }

    // ── Save JSON ──────────────────────────────────────────────────────────────

    const results = {
      framework: 'joule',
      model: 'gpt-4o-mini',
      provider: 'openai',
      budget_preset: budgetPreset,
      runs_per_task: runsPerTask,
      ablation_config: currentConfig,
      timestamp: new Date().toISOString(),
      energy_model: {
        model: 'gpt-4o-mini',
        input_wh_per_million: 0.3,
        output_wh_per_million: 1.2,
        source: 'estimated',
      },
      overall,
      category_summaries: categorySummaries,
      measurements,
    };

    fs.mkdirSync('paper/results', { recursive: true });
    const outputPath = `paper/results/paper-joule-${currentConfig}-results.json`;
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\n  Results saved to ${outputPath}`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('  ALL ABLATION CONFIGURATIONS COMPLETE');
  console.log(`  Configs run: ${configsToRun.join(', ')}`);
  console.log('='.repeat(70) + '\n');
}

main().catch(console.error);
