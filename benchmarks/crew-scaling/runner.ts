/**
 * Runs the same tasks at crew widths 1-4 and records what each width cost.
 *
 * Everything except the crew composition is held constant: same tasks, same
 * model and provider, same tools, same execution mode, same sandbox layout.
 * Crew execution semantics are Joule's own — this runner only observes.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Joule } from '@joule/core';
import { OllamaProvider, OpenAIProvider } from '@joule/models';
import { fileReadTool, fileWriteTool, shellExecTool } from '@joule/tools';
import { generateId } from '@joule/shared';
import type { CrewResult, ModelProviderName, Task } from '@joule/shared';
import { sanitizeFailure } from '../lifecycle/record.js';
import { crewForWidth, roleNames } from './crews.js';
import { contributionOf } from './record.js';
import { loadScalingTasks, prepareTask, type ScalingTask } from './tasks.js';
import type { AgentContribution, CrewScalingRecord, CrewWidth } from './types.js';

export interface RunnerOptions {
  widths: CrewWidth[];
  tasks: number;
  offset: number;
  /** Explicit workload ids; when given, `tasks`/`offset` only bound the search */
  taskIds?: string[];
  /** Repetitions per (task, width); >1 measures run-to-run variance */
  seeds?: number;
  /** Turn the verified-edit gate on for every run */
  verifiedEdit?: boolean;
  provider: string;
  model: string;
  outDir: string;
  label: string;
}

function buildJoule(provider: string, model: string): Joule {
  const name: ModelProviderName = provider === 'ollama' ? 'ollama' : 'openai';
  return new Joule({
    routing: {
      preferLocal: provider === 'ollama',
      preferEfficientModels: false,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: [name], mid: [name], llm: [name] },
    },
    logging: { level: 'error', traceOutput: 'memory' },
  });
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
    defaultHeaders: { 'HTTP-Referer': 'https://github.com/Aagam-Bothara/Joule', 'X-Title': 'Joule crew scaling' },
  }));
}

function toRecord(args: {
  runId: string;
  task: ScalingTask;
  width: CrewWidth;
  seed: number;
  gateEnabled: boolean;
  joulTask: Task;
  crew: CrewResult;
  jctMs: number;
  verdict: { success: boolean; output: string };
}): CrewScalingRecord {
  const contributions = args.crew.agentResults.map(contributionOf);
  const sum = (pick: (c: AgentContribution) => number): number => contributions.reduce((s, c) => s + pick(c), 0);
  const lifecycle = args.crew.agentResults.map(a => a.taskResult.lifecycleMetrics);

  return {
    runId: args.runId,
    taskId: args.joulTask.id,
    workloadId: args.task.workloadId,
    crewWidth: args.width,
    roles: roleNames(args.width),
    seed: args.seed,
    success: args.verdict.success,
    ...(args.verdict.success ? {} : { failureReason: args.verdict.output }),
    crewStatus: args.crew.status,
    ...(sanitizeFailure(args.crew.error) ? { crewError: sanitizeFailure(args.crew.error) } : {}),
    workflowJctMs: args.jctMs,
    totalCostUsd: args.crew.budgetUsed?.costUsd ?? sum(c => c.costUsd ?? 0),
    totalTokens: args.crew.budgetUsed?.tokensUsed ?? sum(c => c.tokens ?? 0),
    modelCalls: sum(c => c.modelCalls),
    toolCalls: sum(c => c.toolCalls),
    modelRuntimeMs: lifecycle.reduce((s, m) => s + (m?.modelRuntimeMs ?? 0), 0),
    toolWaitMs: lifecycle.reduce((s, m) => s + (m?.toolWaitMs ?? 0), 0),
    activeAgents: contributions.filter(c => c.modelCalls > 0 || c.toolCalls > 0).length,
    gateEnabled: args.gateEnabled,
    ...(args.gateEnabled ? {
      proposedWrites: sum(c => c.proposedWrites ?? 0),
      acceptedWrites: sum(c => c.acceptedWrites ?? 0),
      rolledBackWrites: sum(c => c.rolledBackWrites ?? 0),
    } : {}),
    agentResults: contributions,
  };
}

/** A row for a run that threw before a crew result existed. */
function failedRun(args: {
  runId: string;
  task: ScalingTask;
  width: CrewWidth;
  seed: number;
  gateEnabled: boolean;
  joulTask: Task;
  jctMs: number;
  runError: string;
}): CrewScalingRecord {
  return {
    runId: args.runId,
    taskId: args.joulTask.id,
    workloadId: args.task.workloadId,
    crewWidth: args.width,
    roles: roleNames(args.width),
    seed: args.seed,
    success: false,
    failureReason: args.runError,
    runError: args.runError,
    // No resource fields: this run measured nothing. Writing zeros here would
    // make it look like a free, instant run and drag every average down.
    gateEnabled: args.gateEnabled,
    agentResults: [],
  };
}

export async function runCrewScaling(opts: RunnerOptions): Promise<CrewScalingRecord[]> {
  const all = loadScalingTasks(opts.tasks, opts.offset);
  const tasks = opts.taskIds && opts.taskIds.length > 0
    ? opts.taskIds
      .map(id => all.find(t => t.workloadId === id))
      .filter((t): t is ScalingTask => t !== undefined)
    : all;
  if (opts.taskIds && tasks.length !== opts.taskIds.length) {
    const missing = opts.taskIds.filter(id => !tasks.some(t => t.workloadId === id));
    throw new Error(`Task id(s) not in the selected range: ${missing.join(', ')}`);
  }
  const seeds = Math.max(1, opts.seeds ?? 1);
  const runId = `${opts.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(opts.outDir, { recursive: true });

  const joule = buildJoule(opts.provider, opts.model);
  await joule.initialize();
  registerProvider(joule, opts.provider, opts.model);
  for (const tool of [fileReadTool, fileWriteTool, shellExecTool]) joule.registerTool(tool);

  const records: CrewScalingRecord[] = [];
  const startedAt = new Date().toISOString();

  // Task-major order so a run that is cut short still holds complete pairs.
  for (const task of tasks) {
    for (const seed of Array.from({ length: seeds }, (_, i) => i)) {
      for (const width of opts.widths) {
        const prepared = prepareTask(task, width, seed);
        const joulTask: Task = {
          id: generateId('scaling-task'),
          description: prepared.description,
          createdAt: new Date().toISOString(),
          ...(opts.verifiedEdit
            ? { verifiedEdit: { command: 'python run_tests.py', cwd: prepared.dir, timeoutMs: 30_000 } }
            : {}),
        };
        process.stderr.write(`${task.workloadId} w${width} s${seed}: `);
        const began = Date.now();
        try {
          const crew = await joule.executeCrew(crewForWidth(width), joulTask);
          const jctMs = Date.now() - began;
          const verdict = prepared.verify();
          const record = toRecord({ runId, task, width, seed, gateEnabled: Boolean(opts.verifiedEdit), joulTask, crew, jctMs, verdict });
          records.push(record);
          const gateNote = record.gateEnabled
            ? ` writes ${record.acceptedWrites}/${record.proposedWrites} kept, ${record.rolledBackWrites} rolled back`
            : '';
          process.stderr.write(`${verdict.success ? 'PASS' : 'fail'} ${(jctMs / 1000).toFixed(1)}s $${(record.totalCostUsd ?? 0).toFixed(4)} agents ${record.activeAgents ?? 0}/${width}${gateNote}\n`);
        } catch (err) {
          // A run that throws still happened. Recording it keeps the artifact
          // the same shape as the experiment: one row per (task, width, seed),
          // with the reason this one produced nothing.
          const message = sanitizeFailure(err) ?? 'unknown error';
          records.push(failedRun({ runId, task, width, seed, gateEnabled: Boolean(opts.verifiedEdit), joulTask, jctMs: Date.now() - began, runError: message }));
          process.stderr.write(`error: ${message}\n`);
        }
        writeFileSync(join(opts.outDir, 'runs.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
      }
    }
  }

  let gitCommit: string | undefined;
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* not a git checkout */ }

  writeFileSync(join(opts.outDir, 'manifest.json'), JSON.stringify({
    label: opts.label,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    gitCommit,
    provider: opts.provider,
    model: opts.model,
    widths: opts.widths,
    rolesByWidth: Object.fromEntries(opts.widths.map(w => [w, roleNames(w)])),
    strategy: 'sequential',
    executionMode: 'direct (crew default)',
    // Recorded because it changes what a width comparison means: records made
    // before this was fixed have the per-agent budget varying with width.
    budgetMode: crewForWidth(opts.widths[0] ?? 1).budgetMode ?? 'share',
    perAgentBudget: 'high preset per agent (100k tokens), independent of width',
    verifiedEditGate: Boolean(opts.verifiedEdit),
    tasks: tasks.map(t => t.workloadId),
    taskOffset: opts.offset,
    runs: records.length,
    totalCostUsd: records.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0),
    seeds,
    notes: seeds > 1
      ? `${seeds} repetitions per (task, width); repetitions differ only through provider sampling.`
      : 'One run per (task, width): width effects cannot be separated from model stochasticity.',
  }, null, 2));

  await joule.shutdown();
  return records;
}
