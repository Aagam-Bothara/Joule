import { Joule } from '@joule/core';
import { ModelProviderRegistry, OllamaProvider, AnthropicProvider, OpenAIProvider, GoogleProvider, type ModelProvider } from '@joule/models';
import { fileReadTool, fileWriteTool, shellExecTool, httpFetchTool } from '@joule/tools';
import { ModelTier, MODEL_PRICING, type ExecutionMode, type ModelProviderName } from '@joule/shared';
import { LIVE_WORKLOADS } from '../workloads/live.js';
import { loadMbpp } from '../workloads/mbpp.js';
import { loadHumanEval } from '../workloads/humaneval.js';
import { loadMbppBundles } from '../workloads/mbpp-bundle.js';
import { loadSweBench } from '../workloads/swebench.js';
import { STRATEGIES } from '../strategies/index.js';
import { runStrategy } from './run-strategy.js';
import type { GateContext, Strategy, StrategyName, TaskReport, Workload } from '../types.js';

/**
 * Model pair selection: `JOULE_BENCH_SLM` / `JOULE_BENCH_LLM` as `<provider>:<model>`.
 *   provider ∈ google | anthropic | openai | openrouter | ollama
 * Defaults: google:gemini-2.5-flash / google:gemini-2.5-pro.
 * OpenRouter goes through the OpenAI-compatible provider (registered as 'openai').
 */
interface ModelRef { provider: 'google' | 'anthropic' | 'openai' | 'openrouter' | 'ollama'; model: string }

function parseRef(value: string | undefined, fallback: ModelRef): ModelRef {
  if (!value) return fallback;
  const i = value.indexOf(':');
  if (i < 0) throw new Error(`Model ref must be <provider>:<model>, got "${value}"`);
  return { provider: value.slice(0, i) as ModelRef['provider'], model: value.slice(i + 1) };
}

/** Registry name used inside Joule for a ref (OpenRouter rides on the OpenAI provider). */
const registryName = (p: ModelRef['provider']): ModelProviderName => (p === 'openrouter' ? 'openai' : p);

export interface LiveRunOptions {
  workload: 'live' | 'mbpp' | 'humaneval' | 'mbpp-bundle' | 'swebench';
  n?: number;
  offset?: number;
  /** Problems per task for the long-horizon bundle workload. Default 4 */
  bundle?: number;
  /** Run slm-only this many times per task to estimate P(SLM solves task). Default 1 */
  repeats?: number;
  /** Task reports from an earlier (partial) run; matching (task, strategy, repeat) runs are skipped */
  resume?: TaskReport[];
  /** Called after every workload with all reports so far, for checkpointing */
  onCheckpoint?: (reports: TaskReport[]) => void;
}

export async function runLiveBenchmarks(strategyNames: StrategyName[], taskIds?: string[], options: LiveRunOptions = { workload: 'live' }): Promise<{ reports: TaskReport[]; models: { slm: string; llm: string } }> {
  const slm = parseRef(process.env.JOULE_BENCH_SLM, { provider: 'google', model: 'gemini-2.5-flash' });
  const llm = parseRef(process.env.JOULE_BENCH_LLM, { provider: 'google', model: 'gemini-2.5-pro' });
  const mid = process.env.JOULE_BENCH_MID ? parseRef(process.env.JOULE_BENCH_MID, llm) : undefined;
  const providers = buildProviders(slm, llm, mid);
  process.stderr.write(`Models: SLM=${slm.provider}:${slm.model}${mid ? `  MID=${mid.provider}:${mid.model}` : ''}  LLM=${llm.provider}:${llm.model}\n`);

  let workloads: Workload[] = options.workload === 'mbpp'
    ? loadMbpp(options.n ?? 30, options.offset ?? 0)
    : options.workload === 'humaneval'
      ? loadHumanEval(options.n ?? 164, options.offset ?? 0)
      : options.workload === 'mbpp-bundle'
        ? loadMbppBundles(options.n ?? 30, options.bundle ?? 4, options.offset ?? 0)
        : options.workload === 'swebench'
          ? loadSweBench(options.n ?? 15, options.offset ?? 0)
          : LIVE_WORKLOADS;
  if (taskIds) workloads = workloads.filter(w => taskIds.includes(w.id));

  const registry = new ModelProviderRegistry();
  for (const p of providers.values()) registry.register(p);

  const gate: GateContext = {
    callModel: async (tier, system, user, opts) => {
      const ref = tier === 'slm' ? slm : llm;
      const provider = registry.get(registryName(ref.provider));
      if (!provider) throw new Error(`Provider not registered: ${ref.provider}`);
      const res = await provider.chat({
        model: ref.model,
        provider: registryName(ref.provider),
        tier: tier === 'slm' ? ModelTier.SLM : ModelTier.LLM,
        system,
        messages: [{ role: 'user', content: user }],
        temperature: opts?.temperature ?? 0.2,
        maxTokens: opts?.maxTokens ?? 400,
        responseFormat: 'text',
      });
      const tokens = res.tokenUsage.totalTokens;
      const pricing = MODEL_PRICING[ref.model];
      const costUsd = res.costUsd > 0 ? res.costUsd : pricing ? (tokens * (pricing.inputPerMillion + pricing.outputPerMillion) / 2) / 1_000_000 : 0;
      return { content: res.content, costUsd, tokens };
    },
  };

  const createJoule = async (workload: Workload, _mode: ExecutionMode, strategy: Strategy): Promise<Joule> => {
    const escalation = { ...(workload.policy ?? {}), ...(strategy.policy ?? {}), ...(strategy.ladder ? { ladder: strategy.ladder } : {}) };
    const joule = new Joule({
      routing: {
        preferLocal: false,
        preferEfficientModels: false,
        slmConfidenceThreshold: 0.6,
        complexityThreshold: 0.7,
        providerPriority: {
          slm: [registryName(slm.provider)],
          ...(mid ? { mid: [registryName(mid.provider)] } : {}),
          llm: [registryName(llm.provider)],
        },
        ...(Object.keys(escalation).length > 0 ? { escalation: escalation as any } : {}),
      },
      logging: { level: 'error', traceOutput: 'memory' },
    });
    await joule.initialize();
    for (const p of buildProviders(slm, llm, mid).values()) joule.providers.register(p);
    joule.registerTool(fileReadTool);
    joule.registerTool(fileWriteTool);
    joule.registerTool(shellExecTool);
    joule.registerTool(httpFetchTool);
    for (const tool of workload.tools?.() ?? []) joule.registerTool(tool);
    return joule;
  };

  const reports: TaskReport[] = [...(options.resume ?? [])];
  const done = new Set(reports.map(r => `${r.workloadId}|${r.strategy}|${r.repeat ?? ''}`));
  if (reports.length > 0) process.stderr.write(`Resuming: ${reports.length} runs already recorded\n`);
  const repeats = Math.max(1, options.repeats ?? 1);
  for (const workload of workloads) {
    for (const name of strategyNames) {
      const times = name === 'slm-only' ? repeats : 1;
      for (let rep = 0; rep < times; rep++) {
      const key = `${workload.id}|${name}|${times > 1 ? rep : ''}`;
      if (done.has(key)) continue;
      const started = Date.now();
      let report: TaskReport;
      try {
        report = await runStrategy(workload, STRATEGIES[name], createJoule, gate);
      } catch (err) {
        // One broken task must not lose the whole run.
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  ${workload.id.padEnd(24)} ${name.padEnd(15)} ERROR ${message.slice(0, 160)}\n`);
        report = {
          workloadId: workload.id, strategy: name, success: false, status: 'error', verifierKind: workload.verify ? 'deterministic' : 'status',
          cost: 0, gateCost: 0, latencyMs: Date.now() - started, slmTokens: 0, llmTokens: 0, llmUsed: false,
          consultations: 0, handoffs: 0, toolCalls: 0, trajectoryLength: 0, modesRun: [], error: message,
        };
      }
      if (times > 1) report.repeat = rep;
      reports.push(report);
      process.stderr.write(`  ${workload.id.padEnd(24)} ${name.padEnd(15)} ${report.success ? 'ok  ' : 'FAIL'} $${report.cost.toFixed(4)}  ${Math.round(report.latencyMs)}ms  llm=${report.llmUsed ? 'y' : 'n'} c=${report.consultations} h=${report.handoffs}  [${((Date.now() - started) / 1000).toFixed(0)}s]\n`);
      for (const err of (report.errors ?? []).slice(0, 3)) process.stderr.write(`      ! ${err}\n`);
      }
    }
    options.onCheckpoint?.(reports);
  }
  return { reports, models: { slm: `${slm.provider}:${slm.model}`, llm: `${llm.provider}:${llm.model}`, ...(mid ? { mid: `${mid.provider}:${mid.model}` } : {}) } };
}

/**
 * Reasoning settings per OpenRouter model. Hybrid "thinking" models spend
 * their output budget on reasoning tokens before the JSON action, which is
 * both slow and, for a step agent, wasted: the step is small and verified
 * afterwards. Default: thinking off for open hybrid models, minimal effort
 * for OpenAI reasoning models, untouched otherwise. Override with
 * JOULE_BENCH_REASONING="<model>=off|minimal|low|medium|high,..." .
 */
function reasoningFor(model: string): Record<string, unknown> | undefined {
  const overrides = Object.fromEntries((process.env.JOULE_BENCH_REASONING ?? '').split(',').filter(Boolean).map(kv => {
    const i = kv.lastIndexOf('=');
    return [kv.slice(0, i), kv.slice(i + 1)];
  }));
  const setting = overrides[model] ?? (/qwen|nemotron|deepseek|glm|gemma/i.test(model) ? 'off' : /gpt-5|\/o[1-9]/i.test(model) ? 'minimal' : undefined);
  if (!setting) return undefined;
  return setting === 'off' ? { reasoning: { enabled: false } } : { reasoning: { effort: setting } };
}

/** One provider instance per registry name, carrying whichever tier models it serves. */
function buildProviders(slm: ModelRef, llm: ModelRef, mid?: ModelRef): Map<ModelProviderName, ModelProvider> {
  const out = new Map<ModelProviderName, ModelProvider>();
  const key = (env: string) => process.env[`JOULE_${env}`] ?? process.env[env];
  const refsFor = (name: ModelProviderName) => ({
    slmModel: registryName(slm.provider) === name ? slm.model : undefined,
    midModel: mid && registryName(mid.provider) === name ? mid.model : undefined,
    llmModel: registryName(llm.provider) === name ? llm.model : undefined,
  });

  for (const ref of mid ? [slm, mid, llm] : [slm, llm]) {
    const name = registryName(ref.provider);
    if (out.has(name)) continue;
    const models = refsFor(name);
    switch (ref.provider) {
      case 'google': {
        const apiKey = key('GOOGLE_API_KEY');
        if (!apiKey) throw new Error('JOULE_GOOGLE_API_KEY is not set');
        out.set(name, new GoogleProvider({ apiKey, ...models }));
        break;
      }
      case 'anthropic': {
        const apiKey = key('ANTHROPIC_API_KEY');
        if (!apiKey) throw new Error('JOULE_ANTHROPIC_API_KEY is not set');
        out.set(name, new AnthropicProvider({ apiKey, ...models }));
        break;
      }
      case 'openai': {
        const apiKey = key('OPENAI_API_KEY');
        if (!apiKey) throw new Error('JOULE_OPENAI_API_KEY is not set');
        out.set(name, new OpenAIProvider({ apiKey, ...models }));
        break;
      }
      case 'openrouter': {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
        const ids = [models.slmModel, models.midModel, models.llmModel].filter((m): m is string => !!m);
        out.set(name, new OpenAIProvider({
          apiKey,
          ...models,
          baseUrl: 'https://openrouter.ai/api/v1',
          jsonMode: false,
          defaultHeaders: { 'HTTP-Referer': 'https://github.com/Aagam-Bothara/Joule', 'X-Title': 'Joule benchmark' },
          extraBodyByModel: Object.fromEntries(ids.map(m => [m, reasoningFor(m)]).filter(([, v]) => v !== undefined) as Array<[string, Record<string, unknown>]>),
          logprobs: process.env.JOULE_BENCH_LOGPROBS === '1',
        }));
        break;
      }
      case 'ollama': {
        out.set(name, new OllamaProvider({ baseUrl: 'http://localhost:11434', model: models.slmModel ?? models.llmModel ?? 'llama3.2:3b' }));
        break;
      }
    }
  }
  return out;
}
