/**
 * Crew workload runner for lifecycle characterization.
 *
 *   npx tsx benchmarks/lifecycle/crew-runner.ts --workflows 10
 *   npx tsx benchmarks/lifecycle/crew-runner.ts --workflows 2 --provider ollama --model phi3:latest
 *
 * Runs real Joule crews against real repository work, in ONE process so the
 * monotonic lifecycle timestamps stay comparable across agents, and writes the
 * records the existing collector/analyzer already understand.
 *
 * It changes nothing about how crews execute: whether agents overlap is the
 * strategy's business (`parallel` runs them through Promise.allSettled,
 * `sequential` does not), and this runner only observes the result.
 *
 * Provider is chosen with --provider / JOULE_LIFECYCLE_PROVIDER:
 *   openrouter (default, needs OPENROUTER_API_KEY), openai, ollama.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Joule } from '@joule/core';
import { OllamaProvider, OpenAIProvider } from '@joule/models';
import { fileReadTool, fileWriteTool, shellExecTool } from '@joule/tools';
import { generateId } from '@joule/shared';
import type { CrewDefinition, ModelProviderName, Task } from '@joule/shared';
import { recordsFromCrewResult, toJsonl } from './record.js';
import { renderValidation, validateRecords } from './validate.js';
import type { AgentLifecycleRecord } from './types.js';

const CREW_DIR = resolve('benchmarks/lifecycle/crews');
const DEFAULT_OUT = resolve('benchmarks/experiments/lifecycle/real-crews');
const SANDBOX = resolve('benchmarks/.sandbox/lifecycle');

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Real repository work: every task names paths that exist in this repo. */
const PLAN: Array<{ crew: string; task: string }> = [
  { crew: 'repo-analysis', task: 'Analyse packages/core/src/adaptive/escalation-policy.ts: what triggers an escalation and in what order are the rules checked?' },
  { crew: 'parallel-inspect', task: 'Inspect the benchmarks/lifecycle directory: its structure, the types in types.ts, the tests under benchmarks/tests, and what benchmarks/README.md says about lifecycle characterization.' },
  { crew: 'implement-review', task: `Create ${join(SANDBOX, 'wordcount.py').replace(/\\/g, '/')} which defines count_words(text) returning the number of whitespace-separated words, and prints count_words("a b c"). Then run it with python.` },
  { crew: 'repo-analysis', task: 'Analyse packages/core/src/adaptive/lifecycle.ts: what states exist, how are transitions validated, and what does computeLifecycleMetrics measure?' },
  { crew: 'parallel-inspect', task: 'Inspect packages/shared/src/types: the directory layout, the types in lifecycle.ts, the tests under packages/shared/tests, and what the README says about the shared package.' },
  { crew: 'implement-review', task: `Create ${join(SANDBOX, 'primes.py').replace(/\\/g, '/')} which prints the first 10 prime numbers, one per line. Then run it with python.` },
  { crew: 'repo-analysis', task: 'Analyse packages/core/src/direct-executor.ts: what loop does it run, when does it stop, and how does it handle tool failures?' },
  { crew: 'parallel-inspect', task: 'Inspect the packages/models directory: its structure, the provider types, the tests under packages/models/tests, and what packages/models/README.md documents.' },
  { crew: 'implement-review', task: `Create ${join(SANDBOX, 'fizzbuzz.py').replace(/\\/g, '/')} which prints FizzBuzz for 1 to 15. Then run it with python.` },
  { crew: 'repo-analysis', task: 'Analyse packages/core/src/adaptive/verifier.ts: which verification kinds exist and which of them run external commands?' },
];

function loadCrew(name: string): CrewDefinition {
  return JSON.parse(readFileSync(join(CREW_DIR, `${name}.json`), 'utf8')) as CrewDefinition;
}

function gitCommit(): string | undefined {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function buildJoule(provider: string): Joule {
  const name: ModelProviderName = provider === 'ollama' ? 'ollama' : 'openai';
  const joule = new Joule({
    routing: {
      preferLocal: provider === 'ollama',
      preferEfficientModels: false,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: [name], mid: [name], llm: [name] },
    },
    logging: { level: 'error', traceOutput: 'memory' },
  });
  return joule;
}

function registerProvider(joule: Joule, provider: string, model: string): void {
  if (provider === 'ollama') {
    joule.providers.register(new OllamaProvider({ baseUrl: 'http://localhost:11434', model }));
    return;
  }
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    joule.providers.register(new OpenAIProvider({ apiKey, slmModel: model, midModel: model, llmModel: model }));
    return;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  joule.providers.register(new OpenAIProvider({
    apiKey,
    slmModel: model,
    midModel: model,
    llmModel: model,
    baseUrl: 'https://openrouter.ai/api/v1',
    jsonMode: false,
    defaultHeaders: { 'HTTP-Referer': 'https://github.com/Aagam-Bothara/Joule', 'X-Title': 'Joule lifecycle characterization' },
  }));
}

async function main(): Promise<void> {
  const workflows = Number(arg('--workflows', '10'));
  const provider = arg('--provider') ?? process.env.JOULE_LIFECYCLE_PROVIDER ?? 'openrouter';
  const model = arg('--model') ?? process.env.JOULE_LIFECYCLE_MODEL ?? 'deepseek/deepseek-v4-flash';
  const outDir = resolve(arg('--out-dir') ?? DEFAULT_OUT);
  const label = arg('--label') ?? basename(outDir);
  const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const joule = buildJoule(provider);
  await joule.initialize();
  registerProvider(joule, provider, model);
  for (const tool of [fileReadTool, fileWriteTool, shellExecTool]) joule.registerTool(tool);

  const records: AgentLifecycleRecord[] = [];
  const executed: Array<{ workflow: number; crew: string; strategy: string; agents: string[]; taskId: string; status: string; ms: number }> = [];
  const startedAt = new Date().toISOString();

  // --crew / --task pin one workflow, for validating the plumbing cheaply.
  const crewOverride = arg('--crew');
  const taskOverride = arg('--task');

  for (let i = 0; i < workflows; i++) {
    const plan = crewOverride
      ? { crew: crewOverride, task: taskOverride ?? 'Read package.json and report the "name" field in one sentence.' }
      : PLAN[i % PLAN.length];
    const crew = loadCrew(plan.crew);
    const task: Task = { id: generateId('crew-task'), description: plan.task, createdAt: new Date().toISOString() };
    process.stderr.write(`[${i + 1}/${workflows}] ${crew.name} (${crew.strategy}, ${crew.agents.length} agents)\n`);

    const began = Date.now();
    try {
      const result = await joule.executeCrew(crew, task);
      const found = recordsFromCrewResult(result, runId);
      records.push(...found);
      executed.push({
        workflow: i + 1, crew: crew.name, strategy: crew.strategy ?? 'sequential',
        agents: crew.agents.map(a => a.id), taskId: task.id, status: result.status, ms: Date.now() - began,
      });
      process.stderr.write(`    ${result.status} in ${((Date.now() - began) / 1000).toFixed(1)}s, ${found.length} record(s)\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      executed.push({
        workflow: i + 1, crew: crew.name, strategy: crew.strategy ?? 'sequential',
        agents: crew.agents.map(a => a.id), taskId: task.id, status: `error: ${message}`, ms: Date.now() - began,
      });
      process.stderr.write(`    failed: ${message}\n`);
    }
    // Incremental write: a long run that dies still leaves usable data.
    writeFileSync(join(outDir, 'runs.jsonl'), toJsonl(records));
  }

  const validation = validateRecords(records);
  const manifest = {
    label,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    source: 'crew-runner',
    provider,
    model,
    executionModes: [...new Set(records.map(r => r.executionMode))],
    workflowsRequested: workflows,
    workflowsExecuted: executed.length,
    records: records.length,
    agents: new Set(records.map(r => r.agentId)).size,
    crews: executed,
    dataQuality: {
      usable: validation.ok.length,
      rejected: validation.rejected.length,
      issues: validation.issues,
    },
    notes: 'Single process; monotonic lifecycle timestamps are comparable across all records in this runId.',
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  process.stderr.write(`\n${records.length} record(s) from ${executed.length} workflow(s) written to ${join(outDir, 'runs.jsonl')}\n`);
  process.stderr.write(`${renderValidation(validation)}\n`);
  await joule.shutdown();
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
