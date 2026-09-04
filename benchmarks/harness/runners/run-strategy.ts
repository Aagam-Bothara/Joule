import { generateId, type ExecutionMode, type Task, type TaskResult } from '@joule/shared';
import type { Joule } from '@joule/core';
import type { GateContext, Strategy, TaskReport, Workload } from '../types.js';
import { evaluateSuccess } from '../evaluators/success.js';

const JUDGE_THRESHOLD = 0.7;
const SELF_VERIFY_SAMPLES = 3;

/**
 * Run one workload under one strategy.
 *
 * Single-mode strategies run once. Multi-mode strategies run their modes in
 * order and stop when the trigger says the answer is good enough:
 *   failure      → next mode only if the run did not complete
 *   judge        → next mode if a cheap scorer rates the answer below threshold
 *   self-verify  → next mode if the model's own k-sample verification says "no"
 * Pre-routing strategies pick one mode up front with a classification call.
 *
 * Gate calls (scorer, verifier, router) are charged to the strategy's cost.
 * The harness's own ground-truth verifier is never used to drive escalation.
 */
export async function runStrategy(
  workload: Workload,
  strategy: Strategy,
  createJoule: (workload: Workload, mode: ExecutionMode, strategy: Strategy) => Promise<Joule>,
  gate?: GateContext,
  budget: Task['budget'] = 'high',
): Promise<TaskReport> {
  const acc: TaskReport = {
    workloadId: workload.id,
    strategy: strategy.name,
    success: false,
    status: 'pending',
    verifierKind: workload.verify ? 'deterministic' : 'status',
    cost: 0,
    gateCost: 0,
    latencyMs: 0,
    slmTokens: 0,
    llmTokens: 0,
    llmUsed: false,
    consultations: 0,
    handoffs: 0,
    toolCalls: 0,
    trajectoryLength: 0,
    modesRun: [],
  };

  let modes = strategy.modes;
  if (strategy.preRoute) {
    if (!gate) throw new Error(`${strategy.name} needs a gate context`);
    const hard = await preRoute(gate, workload, acc);
    modes = [hard ? 'llm-only' : 'slm-only'];
  }

  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i];
    workload.setup?.();
    const joule = await createJoule(workload, mode, strategy);
    let result: TaskResult | undefined;
    const started = Date.now();
    try {
      result = await joule.execute({ id: generateId('bench'), description: workload.description, budget: workload.budget ?? budget, mode, createdAt: new Date().toISOString() });
    } catch (err) {
      acc.error = err instanceof Error ? err.message : String(err);
      acc.status = 'error';
      acc.latencyMs += Date.now() - started;
      acc.modesRun.push(mode);
      await joule.shutdown();
      continue;
    }
    await joule.shutdown();

    const { success, verifierKind } = evaluateSuccess(result, workload);
    const t = result.trajectory;
    const tier = result.trace.tierUsage;
    acc.success = success;
    acc.status = result.status;
    acc.verifierKind = verifierKind;
    acc.cost += result.budgetUsed.costUsd;
    acc.latencyMs += result.trace.totalDurationMs ?? (Date.now() - started);
    acc.slmTokens += tier?.slmTokens ?? 0;
    acc.midTokens = (acc.midTokens ?? 0) + (tier?.midTokens ?? 0);
    acc.llmTokens += tier?.llmTokens ?? 0;
    acc.consultations += t?.consultations ?? 0;
    acc.handoffs += t?.handoffs ?? 0;
    acc.toolCalls += result.budgetUsed.toolCallsUsed;
    acc.trajectoryLength += t?.trajectoryLength ?? result.stepResults.length;
    acc.trajectory = t;
    acc.error = result.error;
    acc.modesRun.push(mode);
    const traceErrors = collectErrors(result.trace.spans);
    if (traceErrors.length > 0) acc.errors = [...(acc.errors ?? []), ...traceErrors];
    if (t?.estimatedLlmOnlyCostUsd !== undefined) acc.estimatedLlmOnlyCost = (acc.estimatedLlmOnlyCost ?? 0) + t.estimatedLlmOnlyCostUsd;

    const isLast = i === modes.length - 1;
    if (isLast) break;

    // Decide whether to escalate to the next mode — using only signals the strategy itself can observe.
    const answer = workload.answerForJudge?.(result) ?? result.result ?? '';
    let escalate: boolean;
    switch (strategy.escalateOn) {
      case 'failure':
        escalate = result.status !== 'completed';
        break;
      case 'judge':
        if (!gate) throw new Error(`${strategy.name} needs a gate context`);
        escalate = result.status !== 'completed' || (await judgeScore(gate, workload, answer, acc)) < JUDGE_THRESHOLD;
        break;
      case 'self-verify':
        if (!gate) throw new Error(`${strategy.name} needs a gate context`);
        escalate = result.status !== 'completed' || !(await selfVerify(gate, workload, answer, acc));
        break;
      default:
        escalate = false;
    }
    if (!escalate) break;
  }

  // "Escalated" means any rung above the small model was used (middle or top).
  acc.llmUsed = acc.llmTokens > 0 || (acc.midTokens ?? 0) > 0;
  return acc;
}

// ── Gates ───────────────────────────────────────────────────────────

// Gate calls get a generous output cap: "thinking" models (Gemini 2.5) spend
// output tokens before the visible answer, and an empty reply must not be
// mistaken for a verdict. The final token of the reply carries the verdict.

/** RouteLLM-style: predict whether the small model can handle the task. */
async function preRoute(gate: GateContext, workload: Workload, acc: TaskReport): Promise<boolean> {
  const r = await gate.callModel(
    'slm',
    'You are a routing classifier. Decide whether a small, cheap language model can complete the task correctly on its own, or whether it needs a large frontier model. Think briefly if you must, then end your reply with exactly one word on its own line: SMALL or LARGE.',
    `Task:\n${workload.description.slice(0, 2000)}`,
    { temperature: 0, maxTokens: 256 },
  );
  charge(acc, r, 'slm', `route: ${r.content.trim().slice(-40)}`);
  return /LARGE\W*$/i.test(r.content.trim());
}

/** FrugalGPT-style scorer: a 0-1 quality score from a cheap model. */
async function judgeScore(gate: GateContext, workload: Workload, answer: string, acc: TaskReport): Promise<number> {
  const r = await gate.callModel(
    'slm',
    'You are a strict answer scorer. Given a task and a candidate answer, estimate the probability that the answer fully and correctly completes the task. Think briefly if you must, then end your reply with only the number between 0 and 1 on its own line.',
    `Task:\n${workload.description.slice(0, 2000)}\n\nCandidate answer:\n${answer.slice(0, 4000)}`,
    { temperature: 0, maxTokens: 256 },
  );
  const numbers = r.content.match(/(?:0?\.\d+|[01](?:\.\d+)?)/g) ?? [];
  const n = parseFloat(numbers[numbers.length - 1] ?? '');
  charge(acc, r, 'slm', `judge: ${Number.isFinite(n) ? n : 'unparsed'}`);
  return Number.isFinite(n) ? n : 0;
}

/** AutoMix-style self-verification: k sampled yes/no judgements by the small model. */
async function selfVerify(gate: GateContext, workload: Workload, answer: string, acc: TaskReport): Promise<boolean> {
  let yes = 0;
  for (let i = 0; i < SELF_VERIFY_SAMPLES; i++) {
    const r = await gate.callModel(
      'slm',
      'You are verifying your own previous answer. Given the task and the answer, decide whether the answer is correct and complete. Think briefly if you must, then end your reply with exactly one word on its own line: YES or NO.',
      `Task:\n${workload.description.slice(0, 2000)}\n\nAnswer:\n${answer.slice(0, 4000)}`,
      { temperature: 0.7, maxTokens: 256 },
    );
    const verdict = /YES\W*$/i.test(r.content.trim());
    charge(acc, r, 'slm', `verify: ${verdict ? 'YES' : 'NO'}`);
    if (verdict) yes++;
  }
  return yes * 2 > SELF_VERIFY_SAMPLES;
}

function charge(acc: TaskReport, r: { costUsd: number; tokens: number }, tier: 'slm' | 'llm', note?: string): void {
  acc.cost += r.costUsd;
  acc.gateCost += r.costUsd;
  if (tier === 'slm') acc.slmTokens += r.tokens; else acc.llmTokens += r.tokens;
  if (note) acc.gateOutputs = [...(acc.gateOutputs ?? []), note];
}

/** Error events recorded in the trace (model failures, tool failures), for diagnosing live runs. */
function collectErrors(spans: TaskResult['trace']['spans']): string[] {
  const out: string[] = [];
  for (const span of spans) {
    for (const e of span.events) {
      if (e.type === 'error') {
        const type = String(e.data.type ?? 'error');
        const message = String(e.data.message ?? '').slice(0, 300);
        out.push(message ? `${type}: ${message}` : type);
      }
    }
    out.push(...collectErrors(span.children));
  }
  return out;
}
