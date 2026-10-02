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
import type { CrewDefinition, CrewResult, ModelProviderName, Task, ToolDefinition } from '@joule/shared';
import { sanitizeFailure } from '../lifecycle/record.js';
import { crewForWidth, roleNames } from './crews.js';
import { contributionOf, crewBilling, manifestBilling } from './record.js';
import { gatePolicy, loadScalingTasks, prepareTask, type PreparedTask, type ScalingTask } from './tasks.js';
import type { AgentContribution, CrewScalingRecord, CrewWidth } from './types.js';

/**
 * One unit of work the runner can give a crew, at any width.
 *
 * The loop below cares about three things only: what to call the workload,
 * how to lay it out for a run, and how to judge the result. Keeping that as an
 * interface is what lets a different experiment supply repositories with
 * planted defects instead of MBPP problems, without a second copy of the
 * runner and its bookkeeping.
 */
export interface ScalingWorkload {
  workloadId: string;
  prepare(width: CrewWidth, seed: number): PreparedTask;
}

export interface RunnerOptions {
  widths: CrewWidth[];
  tasks: number;
  offset: number;
  /**
   * Workloads to run. Defaults to the MBPP set picked out by `tasks`/`offset`,
   * which is what datasets E and E2 used.
   */
  workloads?: ScalingWorkload[];
  /**
   * Builds the crew for a width. Defaults to the crew-scaling composition;
   * an experiment that needs different iteration or time limits supplies its
   * own rather than changing the definitions another dataset was run with.
   */
  crewFactory?: (width: CrewWidth) => CrewDefinition;
  /** Explicit workload ids; when given, `tasks`/`offset` only bound the search */
  taskIds?: string[];
  /** Repetitions per (task, width); >1 measures run-to-run variance */
  seeds?: number;
  /** Turn the verified-edit gate on for every run */
  verifiedEdit?: boolean;
  /** Tools the agents get; defaults to the local file and shell trio */
  tools?: ToolDefinition[];
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

/**
 * The same runtime `runCrewScaling` builds — routing, provider, tools — for
 * experiments that run single agents outside it. Shut it down when done.
 */
export async function startRuntime(provider: string, model: string, tools: ToolDefinition[]): Promise<Joule> {
  const joule = buildJoule(provider, model);
  await joule.initialize();
  try {
    registerProvider(joule, provider, model);
  } catch (err) {
    await joule.shutdown();
    throw err;
  }
  for (const tool of tools) joule.registerTool(tool);
  return joule;
}

function toRecord(args: {
  runId: string;
  task: ScalingWorkload;
  width: CrewWidth;
  seed: number;
  gateEnabled: boolean;
  joulTask: Task;
  crew: CrewResult;
  jctMs: number;
  verdict: { success: boolean; output: string; record?: object };
}): CrewScalingRecord {
  const contributions = args.crew.agentResults.map(contributionOf);
  const sum = (pick: (c: AgentContribution) => number): number => contributions.reduce((s, c) => s + pick(c), 0);
  const lifecycle = args.crew.agentResults.map(a => a.taskResult.lifecycleMetrics);

  return {
    runId: args.runId,
    taskId: args.joulTask.id,
    workloadId: args.task.workloadId,
    crewWidth: args.width,
    // The agents that actually ran: a custom crew factory may not match the
    // composition the width implies.
    roles: args.crew.agentResults.map(a => a.agentId),
    seed: args.seed,
    success: args.verdict.success,
    ...(args.verdict.success ? {} : { failureReason: args.verdict.output }),
    crewStatus: args.crew.status,
    ...(sanitizeFailure(args.crew.error) ? { crewError: sanitizeFailure(args.crew.error) } : {}),
    workflowJctMs: args.jctMs,
    totalCostUsd: args.crew.budgetUsed?.costUsd ?? sum(c => c.costUsd ?? 0),
    ...crewBilling(contributions),
    totalTokens: args.crew.budgetUsed?.tokensUsed ?? sum(c => c.tokens ?? 0),
    modelCalls: sum(c => c.modelCalls),
    toolCalls: sum(c => c.toolCalls),
    modelRuntimeMs: lifecycle.reduce((s, m) => s + (m?.modelRuntimeMs ?? 0), 0),
    toolWaitMs: lifecycle.reduce((s, m) => s + (m?.toolWaitMs ?? 0), 0),
    activeAgents: contributions.filter(c => c.modelCalls > 0 || c.toolCalls > 0).length,
    gateEnabled: args.gateEnabled,
    ...(args.crew.staged ? { staged: args.crew.staged } : {}),
    ...(args.gateEnabled ? {
      proposedWrites: sum(c => c.proposedWrites ?? 0),
      acceptedWrites: sum(c => c.acceptedWrites ?? 0),
      rolledBackWrites: sum(c => c.rolledBackWrites ?? 0),
    } : {}),
    // Fields the workload measured itself (a real repository's hidden score).
    ...(args.verdict.record ?? {}),
    agentResults: contributions,
  };
}

/** A row for a run that threw before a crew result existed. */
function failedRun(args: {
  runId: string;
  task: ScalingWorkload;
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

/** MBPP problems, wrapped as workloads. The default source. */
function mbppWorkloads(count: number, offset: number): ScalingWorkload[] {
  return loadScalingTasks(count, offset).map((task: ScalingTask) => ({
    workloadId: task.workloadId,
    prepare: (width: CrewWidth, seed: number) => prepareTask(task, width, seed),
  }));
}

export async function runCrewScaling(opts: RunnerOptions): Promise<CrewScalingRecord[]> {
  const all = opts.workloads ?? mbppWorkloads(opts.tasks, opts.offset);
  const tasks = opts.taskIds && opts.taskIds.length > 0
    ? opts.taskIds
      .map(id => all.find(t => t.workloadId === id))
      .filter((t): t is ScalingWorkload => t !== undefined)
    : all;
  if (opts.taskIds && tasks.length !== opts.taskIds.length) {
    const missing = opts.taskIds.filter(id => !tasks.some(t => t.workloadId === id));
    throw new Error(`Task id(s) not in the selected range: ${missing.join(', ')}`);
  }
  const buildCrew = opts.crewFactory ?? crewForWidth;
  const seeds = Math.max(1, opts.seeds ?? 1);
  const runId = `${opts.label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  mkdirSync(opts.outDir, { recursive: true });

  const joule = buildJoule(opts.provider, opts.model);
  await joule.initialize();
  try {
    registerProvider(joule, opts.provider, opts.model);
  } catch (err) {
    // Shut down before giving up: an initialized runtime left running keeps
    // the process alive, so a misconfiguration would hang instead of failing.
    await joule.shutdown();
    throw err;
  }
  for (const tool of opts.tools ?? [fileReadTool, fileWriteTool, shellExecTool]) joule.registerTool(tool);

  const records: CrewScalingRecord[] = [];
  const startedAt = new Date().toISOString();

  // Task-major order so a run that is cut short still holds complete pairs.
  for (const task of tasks) {
    for (const seed of Array.from({ length: seeds }, (_, i) => i)) {
      for (const width of opts.widths) {
        const prepared = task.prepare(width, seed);
        const joulTask: Task = {
          id: generateId('scaling-task'),
          description: prepared.description,
          createdAt: new Date().toISOString(),
          ...(opts.verifiedEdit ? { verifiedEdit: gatePolicy(prepared) } : {}),
        };
        process.stderr.write(`${task.workloadId} w${width} s${seed}: `);
        const began = Date.now();
        try {
          const crew = await joule.executeCrew(buildCrew(width), joulTask);
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
    billing: manifestBilling(records),
    seeds,
    notes: seeds > 1
      ? `${seeds} repetitions per (task, width); repetitions differ only through provider sampling.`
      : 'One run per (task, width): width effects cannot be separated from model stochasticity.',
  }, null, 2));

  await joule.shutdown();
  return records;
}
