import {
  type Task,
  type TaskResult,
  type TaskSpec,
  type PlanScore,
  type SimulationResult,
  type StepResult,
  type StepVerification,
  type CriterionResult,
  type SuccessCriterion,
  type AgentState,
  type FailurePattern,
  type ModelRequest,
  type ChatMessage,
  type BudgetUsage,
  type EnergyConfig,
  type EfficiencyReport,
  type RoutingConfig,
  type ExecutionPathConfig,
  ModelTier,
  generateId,
  BudgetExhaustedError,
  PlanValidationError,
  ConstitutionViolationError,
  buildEfficiencyReport,
  isoNow,
} from '@joule/shared';
import { ModelProviderRegistry, type StreamChunk } from '@joule/models';
import { BudgetManager, type BudgetEnvelopeInstance } from './budget-manager.js';
import { ModelRouter } from './model-router.js';
import { TraceLogger } from './trace-logger.js';
import { ToolRegistry } from './tool-registry.js';
import { Planner, type ExecutionPlan, type PlanStep } from './planner.js';
import { ExecutionSimulator } from './execution-simulator.js';
import type { ConstitutionEnforcer } from './constitution.js';
import { ExecutionPathSelector } from './execution-path/index.js';
import { AdaptiveController, type ExecutionState } from './adaptive-controller.js';

const DEFAULT_MAX_REPLAN_DEPTH = 2;

const SYNTHESIZE_SYSTEM_PROMPT_BASE = `You are a result synthesizer. Given a task description and the results of tool executions, provide a clear, concise answer to the original task. Be direct and factual.`;
const DIRECT_ANSWER_SYSTEM_PROMPT_BASE = `You are Joule, a helpful AI assistant. Answer the user's question directly and concisely.`;

export type ProgressCallback = (event: ProgressEvent) => void;

export interface ProgressEvent {
  phase: 'specifying' | 'planning' | 'executing' | 'verifying' | 'recovering' | 'synthesizing';
  stepIndex?: number;
  totalSteps?: number;
  usage: BudgetUsage;
  state?: AgentState;
  /** Agent ID (set when executing within a crew) */
  agentId?: string;
  /** Agent role name (set when executing within a crew) */
  agentRole?: string;
}

interface StateMachineContext {
  state: AgentState;
  task: Task;
  traceId: string;
  envelope: BudgetEnvelopeInstance;
  spec?: TaskSpec;
  plan?: ExecutionPlan;
  planScore?: PlanScore;
  simulationResult?: SimulationResult;
  failurePatterns?: FailurePattern[];
  steps: PlanStep[];
  stepResults: StepResult[];
  currentStepIndex: number;
  replanDepth: number;
  retryCount: number;
  result?: string;
  error?: string;
  onProgress?: ProgressCallback;
  /** Speculative routing: complexity determined by unified plan, reused for all subsequent routing */
  speculativeComplexity?: number;
}

export interface BudgetUpdateEvent {
  agentId?: string;
  agentRole?: string;
  usage: BudgetUsage;
  limits: Record<string, number>;
}

export interface StreamEvent {
  type: 'progress' | 'chunk' | 'result' | 'budget_update';
  progress?: ProgressEvent;
  chunk?: StreamChunk;
  result?: TaskResult;
  budgetUpdate?: BudgetUpdateEvent;
}

export class TaskExecutor {
  private maxReplanDepth: number;
  private constitution?: ConstitutionEnforcer;
  private simulator: ExecutionSimulator;
  private pathSelector?: ExecutionPathSelector;
  private adaptiveController: AdaptiveController;

  constructor(
    private budget: BudgetManager,
    private router: ModelRouter,
    private tracer: TraceLogger,
    private tools: ToolRegistry,
    private planner: Planner,
    private providers: ModelProviderRegistry,
    private energyConfig?: EnergyConfig,
    private routingConfig?: RoutingConfig,
    constitution?: ConstitutionEnforcer,
    executionPathConfig?: Partial<ExecutionPathConfig>,
  ) {
    this.maxReplanDepth = routingConfig?.maxReplanDepth ?? DEFAULT_MAX_REPLAN_DEPTH;
    this.constitution = constitution;
    this.simulator = new ExecutionSimulator(tools);
    this.adaptiveController = new AdaptiveController();
    // Enable execution path selection unless explicitly disabled
    if (executionPathConfig?.enabled !== false) {
      this.pathSelector = new ExecutionPathSelector(router, budget, tracer, executionPathConfig);
    }
  }

  /**
   * Dependency-aware structural pruning: given a set of steps and their results,
   * resolve the transitive dependency closure for a target step and return only
   * the step results that the target actually needs.
   *
   * Design decisions:
   * - Falls back to all results when no dependency metadata exists (backward compat)
   * - Validates declared deps via output-signature taint tracking: extracts unique
   *   tokens from each step's actual output (URLs, paths, IDs, distinctive strings)
   *   and checks if they appear in downstream steps' toolArgs — real data-flow
   *   analysis, not syntactic pattern matching
   * - For synthesis: uses sink-node reachability — only steps reachable backward
   *   from DAG sinks (steps no other step depends on)
   * - Gated by routingConfig.enableDependencyPruning for A/B correctness testing
   */
  /**
   * Compute the adaptive prune threshold for the current execution context.
   * Uses the AdaptiveController to combine plan length, token pressure, complexity,
   * and repair statistics into a single threshold value (0.0–1.0).
   */
  private getAdaptivePruneThreshold(
    steps: PlanStep[],
    envelope: BudgetEnvelopeInstance,
    complexityEstimate: number,
    repairedEdges: number,
    stepFailures: number,
  ): number {
    const usage = this.budget.getUsage(envelope);
    const declaredEdges = steps.reduce(
      (sum, s) => sum + (s.needs?.length ?? 0), 0,
    );
    const state: ExecutionState = {
      planLength: steps.length,
      stepFailures,
      tokensConsumed: usage.tokens,
      tokenBudget: envelope.envelope.maxTokens ?? 100_000,
      complexityEstimate,
      repairedEdges,
      declaredEdges,
      currentStepIndex: steps.length,
    };
    return this.adaptiveController.getPruneThreshold(state);
  }

  /**
   * Compute a pruning confidence score for a step result that is NOT in the
   * reachability closure (i.e., a candidate for pruning).
   *
   * Returns 0.0–1.0 where 1.0 = confident it is safe to prune.
   * Considers three signals:
   *   1. taintSafety     — no taint-tracking evidence of data flow to any live step
   *   2. lexicalSafety   — low lexical overlap between this step's output and the
   *                        task description (high overlap → may be thematically relevant)
   *   3. plannerCoverage — planner declared all deps in the live closure
   *                        (no edges were repaired for this step)
   */
  private computePruneConfidence(
    result: StepResult,
    liveStepIndices: Set<number>,
    repairedFromThisStep: boolean,
    taskDescription: string,
  ): number {
    // Signal 1: taint safety — if a taint-tracking repair originated FROM this step,
    // another step actually used its output via data-flow; don't over-prune
    const taintSafety = repairedFromThisStep ? 0.50 : 1.0;

    // Signal 2: lexical safety — Jaccard similarity between step output terms and task
    const outputText = typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output ?? '');
    const taskTokens = new Set(
      taskDescription.toLowerCase().split(/\W+/).filter(w => w.length > 4),
    );
    const outputTokens = outputText.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    const overlapCount = outputTokens.filter(w => taskTokens.has(w)).length;
    const overlapRate = outputTokens.length > 0 ? overlapCount / outputTokens.length : 0;
    // High overlap → this step is thematically relevant → lower confidence to prune
    const lexicalSafety = Math.max(0, 1.0 - overlapRate * 1.5);

    // Signal 3: output length — very short outputs (e.g. simple confirmations) are
    // safer to prune than rich outputs that likely carry information
    const outputLen = outputText.length;
    const richnessFactor = outputLen > 200 ? 0.90 : 1.0;

    return Math.min(1.0, taintSafety * lexicalSafety * richnessFactor);
  }

  private filterResultsByDependencies(
    steps: PlanStep[],
    stepResults: StepResult[],
    taskDescription: string,
    pruneThreshold: number,
    targetStepIndex?: number,
  ): { filtered: StepResult[]; prunedCount: number; repaired: number } {
    // A/B toggle: when pruning is disabled, pass everything through
    if (this.routingConfig?.enableDependencyPruning === false) {
      return { filtered: stepResults, prunedCount: 0, repaired: 0 };
    }

    // If no steps have dependency info, return all results (safe fallback)
    const hasDependencyInfo = steps.some(s => Array.isArray(s.needs));
    if (!hasDependencyInfo || stepResults.length === 0) {
      return { filtered: stepResults, prunedCount: 0, repaired: 0 };
    }

    // ── Output-signature taint tracking ──
    // Extract distinctive tokens from each completed step's actual output, then check
    // if downstream steps' toolArgs contain those tokens. This catches real data-flow
    // dependencies the LLM failed to declare — e.g. a URL produced by step 0 appearing
    // in step 2's args without step 2 declaring needs:[0].
    const outputSignatures = new Map<number, Set<string>>();
    for (const result of stepResults) {
      outputSignatures.set(result.stepIndex, TaskExecutor.extractOutputSignatures(result.output));
    }

    let repaired = 0;
    // Track which source steps had edges repaired (for confidence scoring)
    const repairedSourceSteps = new Set<number>();
    const repairedSteps = steps.map(s => ({ ...s, needs: s.needs ? [...s.needs] : undefined }));
    for (const step of repairedSteps) {
      if (!Array.isArray(step.needs)) continue;
      const argsText = JSON.stringify(step.toolArgs);
      for (let prior = 0; prior < step.index; prior++) {
        if (step.needs.includes(prior)) continue;
        const sigs = outputSignatures.get(prior);
        if (!sigs || sigs.size === 0) continue;
        // If any distinctive output token from a prior step appears in this step's args,
        // that's a real data-flow dependency the LLM missed
        for (const sig of sigs) {
          if (argsText.includes(sig)) {
            step.needs.push(prior);
            repaired++;
            repairedSourceSteps.add(prior);
            break; // One match is enough to establish the edge
          }
        }
      }
    }

    // ── Transitive closure BFS ──
    const computeClosure = (seeds: number[]): Set<number> => {
      const needed = new Set<number>();
      const queue = [...seeds];
      while (queue.length > 0) {
        const idx = queue.pop()!;
        if (needed.has(idx)) continue;
        needed.add(idx);
        const step = repairedSteps[idx];
        if (Array.isArray(step?.needs)) {
          for (const dep of step.needs) {
            if (!needed.has(dep)) queue.push(dep);
          }
        }
      }
      return needed;
    };

    // ── Confidence-aware filtering helper ───────────────────────────────────────
    // For each step NOT in the reachability closure, compute a prune confidence score.
    // Only prune if score >= pruneThreshold (set by AdaptiveController).
    // This avoids aggressive binary pruning that discards semantically relevant steps.
    const confidenceFilter = (
      results: StepResult[],
      closure: Set<number>,
    ): { filtered: StepResult[]; prunedCount: number } => {
      const filtered: StepResult[] = [];
      let prunedCount = 0;
      for (const r of results) {
        if (closure.has(r.stepIndex)) {
          // In closure — always keep
          filtered.push(r);
        } else {
          const conf = this.computePruneConfidence(
            r,
            closure,
            repairedSourceSteps.has(r.stepIndex),
            taskDescription,
          );
          if (conf >= pruneThreshold) {
            // Confident enough that this step is irrelevant — prune it
            prunedCount++;
          } else {
            // Uncertain — keep it to avoid quality regression
            filtered.push(r);
          }
        }
      }
      return { filtered, prunedCount };
    };

    // ── Sink-node reachability for synthesis ──
    // A "sink" is a step that no other step declares as a dependency — these are the
    // terminal outputs of the DAG. We compute the union of transitive closures from
    // all sinks. This is principled: every step that contributes to ANY final output
    // is kept; pure intermediaries consumed only by other intermediaries can be pruned.
    if (targetStepIndex === undefined) {
      const hasDependents = new Set<number>();
      for (const s of repairedSteps) {
        if (Array.isArray(s.needs)) {
          for (const n of s.needs) hasDependents.add(n);
        }
      }

      const sinks: number[] = [];
      for (let i = 0; i < repairedSteps.length; i++) {
        if (!hasDependents.has(i)) sinks.push(i);
      }
      // Edge case: if every step is depended on, treat the last step as the sink
      if (sinks.length === 0) sinks.push(repairedSteps.length - 1);

      const closure = computeClosure(sinks);
      const { filtered, prunedCount } = confidenceFilter(stepResults, closure);
      return { filtered, prunedCount, repaired };
    }

    // For a specific target step, compute its transitive dependency closure
    const closure = computeClosure([targetStepIndex]);
    closure.delete(targetStepIndex); // Don't include the target itself

    const { filtered, prunedCount } = confidenceFilter(stepResults, closure);
    return { filtered, prunedCount, repaired };
  }

  /**
   * Extract distinctive tokens from a step's output for taint tracking.
   * Returns tokens that are specific enough to indicate real data flow if found
   * in a downstream step's arguments — URLs, file paths, identifiers, hashes, etc.
   *
   * Designed for zero false positives: only extracts tokens that would be
   * astronomically unlikely to appear in unrelated toolArgs by coincidence.
   */
  private static extractOutputSignatures(output: unknown): Set<string> {
    const sigs = new Set<string>();
    if (output == null) return sigs;

    const text = typeof output === 'string' ? output : JSON.stringify(output);

    // URLs — the strongest signal: if step 0 returns a URL and step 2 uses it, that's data flow
    const urlPattern = /https?:\/\/[^\s"'<>,}{)(\]]+/g;
    for (const match of text.matchAll(urlPattern)) {
      sigs.add(match[0]);
    }

    // File paths (Unix and Windows)
    const pathPattern = /(?:\/[\w.-]+){2,}|(?:[A-Z]:\\[\w.-]+(?:\\[\w.-]+)+)/gi;
    for (const match of text.matchAll(pathPattern)) {
      if (match[0].length >= 8) sigs.add(match[0]);
    }

    // UUIDs / hex hashes (8+ hex chars with separators or contiguous)
    const idPattern = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
    for (const match of text.matchAll(idPattern)) {
      sigs.add(match[0]);
    }
    // Standalone hex hashes (SHA-like, 16+ chars to avoid false positives)
    const hexPattern = /\b[0-9a-f]{16,}\b/gi;
    for (const match of text.matchAll(hexPattern)) {
      sigs.add(match[0]);
    }

    // Email addresses
    const emailPattern = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g;
    for (const match of text.matchAll(emailPattern)) {
      sigs.add(match[0]);
    }

    // Quoted distinctive strings (8+ chars, not common words)
    const quotedPattern = /"([^"]{8,120})"/g;
    for (const match of text.matchAll(quotedPattern)) {
      const val = match[1];
      // Skip values that are too generic (common JSON keys, booleans, numbers-only)
      if (/^[\d.]+$/.test(val) || /^(true|false|null|success|error|failed|none)$/i.test(val)) continue;
      // Keep values with mixed case, special chars, or length >= 20 (likely unique content)
      if (val.length >= 20 || /[/:@#?&=]/.test(val) || /[A-Z].*[a-z]|[a-z].*[A-Z]/.test(val)) {
        sigs.add(val);
      }
    }

    // Cap at 50 signatures per step to bound compute
    if (sigs.size > 50) {
      const arr = [...sigs];
      sigs.clear();
      // Prefer URLs and paths (strongest signals) by sorting longer first
      arr.sort((a, b) => b.length - a.length);
      for (let i = 0; i < 50; i++) sigs.add(arr[i]);
    }

    return sigs;
  }

  async execute(task: Task, onProgress?: ProgressCallback): Promise<TaskResult> {
    const traceId = generateId('trace');
    const resultId = generateId('result');

    // Create budget envelope
    const envelope = this.budget.createEnvelope(task.budget);
    this.tracer.createTrace(traceId, task.id, envelope.envelope);
    const rootSpan = this.tracer.startSpan(traceId, 'task-execution', {
      taskId: task.id,
      description: task.description,
    });

    // Initialize state machine context
    const ctx: StateMachineContext = {
      state: 'idle',
      task,
      traceId,
      envelope,
      stepResults: [],
      steps: [],
      currentStepIndex: 0,
      replanDepth: 0,
      retryCount: 0,
      onProgress,
    };

    let status: TaskResult['status'] = 'pending';
    let error: string | undefined;

    try {
      await this.runStateMachine(ctx);
      status = ctx.state === 'done' ? 'completed' : 'failed';
      error = ctx.error;
    } catch (err) {
      if (err instanceof ConstitutionViolationError) {
        status = 'failed';
        error = `Constitution violation [${err.ruleId}]: ${err.message}`;
        this.tracer.logEvent(traceId, 'error', {
          type: 'constitution_violation',
          ruleId: err.ruleId,
          message: err.message,
        });
      } else if (err instanceof BudgetExhaustedError) {
        status = 'budget_exhausted';
        error = err.message;

        // Synthesize partial result from completed steps
        if (ctx.stepResults.length > 0) {
          const partialText = ctx.stepResults
            .filter(r => r.success)
            .map((r, i) => `Step ${i + 1} (${r.toolName}): ${JSON.stringify(r.output)}`)
            .join('\n');
          ctx.result = `[Partial Result - Budget Exhausted (${err.dimension})]\n${partialText}`;
        }

        this.tracer.logEvent(traceId, 'error', {
          type: 'budget_exhausted',
          dimension: err.dimension,
          completedSteps: ctx.stepResults.length,
        });
      } else {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
        this.tracer.logEvent(traceId, 'error', {
          type: 'execution_error',
          message: error,
        });
      }
    }

    this.tracer.endSpan(traceId, rootSpan);
    const budgetUsed = this.budget.getUsage(envelope);
    this.tracer.logBudgetCheckpoint(traceId, 'final', budgetUsed);

    // Build efficiency report
    let efficiencyReport: EfficiencyReport | undefined;
    if (this.energyConfig?.enabled) {
      const energyTotals = this.budget.getEnergyTotals(envelope);
      efficiencyReport = buildEfficiencyReport(
        energyTotals.energyWh,
        energyTotals.carbonGrams,
        energyTotals.totalInputTokens,
        energyTotals.totalOutputTokens,
        'gpt-4o',
        this.energyConfig,
      );
      this.tracer.logEvent(traceId, 'energy_report', efficiencyReport as unknown as Record<string, unknown>);
    }

    // Evaluate success criteria if we have a spec
    let criteriaResults: CriterionResult[] | undefined;
    if (ctx.spec) {
      criteriaResults = this.evaluateCriteria(ctx.spec, ctx.stepResults, ctx.result);
    }

    return {
      id: resultId,
      taskId: task.id,
      traceId,
      status,
      result: ctx.result,
      stepResults: ctx.stepResults,
      budgetUsed,
      trace: this.tracer.getTrace(traceId, budgetUsed),
      error,
      completedAt: isoNow(),
      efficiencyReport,
      spec: ctx.spec,
      criteriaResults,
      simulationResult: ctx.simulationResult,
    };
  }

  async *executeStream(task: Task, onProgress?: ProgressCallback): AsyncGenerator<StreamEvent> {
    const traceId = generateId('trace');
    const resultId = generateId('result');

    const envelope = this.budget.createEnvelope(task.budget);
    this.tracer.createTrace(traceId, task.id, envelope.envelope);
    const rootSpan = this.tracer.startSpan(traceId, 'task-execution', {
      taskId: task.id,
      description: task.description,
    });

    const stepResults: StepResult[] = [];
    let status: TaskResult['status'] = 'pending';
    let error: string | undefined;
    let result: string | undefined;
    let spec: TaskSpec | undefined;

    try {
      // Constitution: validate task description
      if (this.constitution) {
        const taskViolation = this.constitution.validateTask(task.description);
        if (taskViolation) {
          this.tracer.logEvent(traceId, 'constitution_violation', taskViolation as unknown as Record<string, unknown>);
          throw new ConstitutionViolationError(taskViolation.ruleId, taskViolation.ruleName, taskViolation.description);
        }
      }

      // Spec phase — generate task specification
      status = 'specifying';
      const specProgress: ProgressEvent = { phase: 'specifying', usage: this.budget.getUsage(envelope), state: 'spec' };
      onProgress?.(specProgress);
      yield { type: 'progress', progress: specProgress };
      spec = await this.planner.specifyTask(task, envelope, traceId);

      // Planning phase
      status = 'planning';
      const planProgress: ProgressEvent = { phase: 'planning', usage: this.budget.getUsage(envelope), state: 'plan' };
      onProgress?.(planProgress);
      yield { type: 'progress', progress: planProgress };

      const complexity = await this.planner.classifyComplexity(task, envelope, traceId);
      this.budget.checkBudget(envelope);

      const plan = await this.planner.plan(task, complexity, envelope, traceId, spec);
      this.budget.checkBudget(envelope);
      this.planner.validatePlan(plan);

      // Execution phase with re-planning on failure
      status = 'executing';
      const streamProgressCallback = (step: PlanStep, totalSteps: number) => {
        const execProgress: ProgressEvent = { phase: 'executing', stepIndex: step.index, totalSteps, usage: this.budget.getUsage(envelope), state: 'act' };
        onProgress?.(execProgress);
        return { type: 'progress' as const, progress: execProgress };
      };
      yield* this.executeStepsWithReplanStream(task, plan, envelope, traceId, stepResults, streamProgressCallback);

      // Streaming synthesis phase
      status = 'synthesizing';
      const synthProgress: ProgressEvent = { phase: 'synthesizing', usage: this.budget.getUsage(envelope), state: 'synthesize' };
      onProgress?.(synthProgress);
      yield { type: 'progress', progress: synthProgress };

      result = '';
      for await (const chunk of this.synthesizeStream(task, stepResults, envelope, traceId, undefined, plan.steps)) {
        result += chunk.content;
        yield { type: 'chunk', chunk };
      }

      // Constitution: validate synthesized output
      if (this.constitution && result) {
        const outputViolation = this.constitution.validateOutput(result);
        if (outputViolation) {
          this.tracer.logEvent(traceId, 'constitution_output_violation', outputViolation as unknown as Record<string, unknown>);
          result = `[Response filtered by constitution rule ${outputViolation.ruleId}: ${outputViolation.ruleName}]`;
        }
      }

      status = 'completed';
    } catch (err) {
      if (err instanceof ConstitutionViolationError) {
        status = 'failed';
        error = `Constitution violation [${err.ruleId}]: ${err.message}`;
        this.tracer.logEvent(traceId, 'error', {
          type: 'constitution_violation',
          ruleId: err.ruleId,
          message: err.message,
        });
      } else if (err instanceof BudgetExhaustedError) {
        status = 'budget_exhausted';
        error = err.message;

        if (stepResults.length > 0) {
          const partialText = stepResults
            .filter(r => r.success)
            .map((r, i) => `Step ${i + 1} (${r.toolName}): ${JSON.stringify(r.output)}`)
            .join('\n');
          result = `[Partial Result - Budget Exhausted (${err.dimension})]\n${partialText}`;
        }

        this.tracer.logEvent(traceId, 'error', {
          type: 'budget_exhausted',
          dimension: err.dimension,
          completedSteps: stepResults.length,
        });
      } else {
        status = 'failed';
        error = err instanceof Error ? err.message : String(err);
        this.tracer.logEvent(traceId, 'error', {
          type: 'execution_error',
          message: error,
        });
      }
    }

    this.tracer.endSpan(traceId, rootSpan);
    const budgetUsed = this.budget.getUsage(envelope);
    this.tracer.logBudgetCheckpoint(traceId, 'final', budgetUsed);

    let efficiencyReport: EfficiencyReport | undefined;
    if (this.energyConfig?.enabled) {
      const energyTotals = this.budget.getEnergyTotals(envelope);
      efficiencyReport = buildEfficiencyReport(
        energyTotals.energyWh,
        energyTotals.carbonGrams,
        energyTotals.totalInputTokens,
        energyTotals.totalOutputTokens,
        'gpt-4o',
        this.energyConfig,
      );
      this.tracer.logEvent(traceId, 'energy_report', efficiencyReport as unknown as Record<string, unknown>);
    }

    // Evaluate success criteria
    let criteriaResults: CriterionResult[] | undefined;
    if (spec) {
      criteriaResults = this.evaluateCriteria(spec, stepResults, result);
    }

    yield {
      type: 'result',
      result: {
        id: resultId,
        taskId: task.id,
        traceId,
        status,
        result,
        stepResults,
        budgetUsed,
        trace: this.tracer.getTrace(traceId, budgetUsed),
        error,
        completedAt: isoNow(),
        efficiencyReport,
        spec,
        criteriaResults,
      },
    };
  }

  // ─── State Machine ───

  private transitionState(ctx: StateMachineContext, newState: AgentState): void {
    const prev = ctx.state;
    ctx.state = newState;
    this.tracer.logEvent(ctx.traceId, 'state_transition', {
      from: prev,
      to: newState,
    });
  }

  /**
   * Determine whether a task qualifies for the fast path (skip planning,
   * go straight to a single direct-answer LLM call).
   *
   * Criteria:
   * - No tools requested on the task AND no tools registered globally
   * - No action intent detected via regex heuristics
   * - No conversation history (single-turn)
   * - Short description (under 200 chars — unlikely to need multi-step reasoning)
   */
  private isSimpleKnowledgeTask(task: Task): boolean {
    // Task explicitly requests tools → not simple
    if (task.tools && task.tools.length > 0) return false;

    // Tools registered in the registry → planner might route to them
    if (this.tools.list().length > 0) return false;

    // Action intent detected → needs planning
    if (Planner.detectActionIntent(task.description) > 0) return false;

    // Multi-turn conversation → needs context-aware planning
    if (task.messages && task.messages.length > 0) return false;

    // Long descriptions likely need multi-step reasoning
    if (task.description.length > 200) return false;

    return true;
  }

  private async runStateMachine(ctx: StateMachineContext): Promise<void> {
    // IDLE → constitution check
    this.transitionState(ctx, 'idle');

    if (this.constitution) {
      const taskViolation = this.constitution.validateTask(ctx.task.description);
      if (taskViolation) {
        this.tracer.logEvent(ctx.traceId, 'constitution_violation', taskViolation as unknown as Record<string, unknown>);
        throw new ConstitutionViolationError(taskViolation.ruleId, taskViolation.ruleName, taskViolation.description);
      }
    }

    // ── EXECUTION PATH SELECTION (P0–P5) ──
    // Run before any LLM work. For P0–P3, returns a complete result immediately.
    // For P4/P5, falls through to existing pipeline below.
    if (this.pathSelector) {
      const selection = await this.pathSelector.select(ctx.task, this.tools, ctx.envelope, ctx.traceId);

      this.tracer.logEvent(ctx.traceId, 'info', {
        type: 'execution_path_selected',
        path: selection.profile.path,
        confidence: selection.profile.confidence,
        rationale: selection.profile.rationale,
        fromCache: selection.fromCache,
        hasEarlyResult: !!selection.earlyResult,
      });

      if (selection.earlyResult !== undefined) {
        // P0–P3: result is ready — skip entire planning/execution pipeline
        ctx.result = selection.earlyResult;

        // Constitution: validate output
        if (this.constitution && ctx.result) {
          const outputViolation = this.constitution.validateOutput(ctx.result);
          if (outputViolation) {
            this.tracer.logEvent(ctx.traceId, 'constitution_output_violation', outputViolation as unknown as Record<string, unknown>);
            ctx.result = `[Response filtered by constitution rule ${outputViolation.ruleId}: ${outputViolation.ruleName}]`;
          }
        }

        this.transitionState(ctx, 'done');
        return;
      }

      // P5: force LLM tier for escalated tasks
      if (selection.profile.path === 5) {
        ctx.speculativeComplexity = 1.0; // forces LLM tier in all subsequent routing
      }
    }

    // ── FAST PATH: skip planning for simple knowledge tasks ──
    // For pure knowledge questions (no tools, no action intent, short description),
    // skip the entire planning phase and go straight to a single direct-answer call.
    // This reduces 2 LLM calls → 1, cutting token usage by ~50% on simple tasks.
    if (this.isSimpleKnowledgeTask(ctx.task)) {
      this.tracer.logEvent(ctx.traceId, 'fast_path', {
        reason: 'Simple knowledge task — skipping planning phase',
        descriptionLength: ctx.task.description.length,
      });

      // Go straight to SYNTHESIZE with no step results (direct answer mode)
      this.transitionState(ctx, 'synthesize');
      ctx.onProgress?.({ phase: 'synthesizing', usage: this.budget.getUsage(ctx.envelope), state: 'synthesize' });
      ctx.result = await this.synthesize(ctx.task, [], ctx.envelope, ctx.traceId, ctx.speculativeComplexity);

      // Constitution: validate output
      if (this.constitution && ctx.result) {
        const outputViolation = this.constitution.validateOutput(ctx.result);
        if (outputViolation) {
          this.tracer.logEvent(ctx.traceId, 'constitution_output_violation', outputViolation as unknown as Record<string, unknown>);
          ctx.result = `[Response filtered by constitution rule ${outputViolation.ruleId}: ${outputViolation.ruleName}]`;
        }
      }

      this.transitionState(ctx, 'done');
      return;
    }

    // UNIFIED PLAN → try spec + classify + plan + critique in ONE LLM call
    // Saves 3 LLM round-trips (~60% token reduction) compared to separate pipeline
    // Enabled by default; set routing.unifiedPlanning = false to use separate pipeline
    const useUnifiedPlanning = this.routingConfig?.unifiedPlanning !== false;

    this.transitionState(ctx, 'plan');
    ctx.onProgress?.({ phase: 'planning', usage: this.budget.getUsage(ctx.envelope), state: 'plan' });

    const unified = useUnifiedPlanning
      ? await this.planner.unifiedPlan(ctx.task, ctx.envelope, ctx.traceId)
      : null;

    if (unified) {
      // Unified planning succeeded — use its results directly
      ctx.spec = unified.spec;
      ctx.plan = unified.plan;
      ctx.steps = [...unified.plan.steps];
      ctx.planScore = unified.planScore;
      // Speculative routing: cache complexity from unified plan for all subsequent routing calls.
      // This avoids redundant complexity re-evaluation and ensures consistent tier decisions.
      ctx.speculativeComplexity = unified.complexity;
      this.budget.checkBudget(ctx.envelope);

      // ── DIRECT ANSWER SHORTCUT ──
      // If the unified plan returned a directAnswer (low-complexity, no steps),
      // skip the synthesis call entirely — saves 1 LLM round-trip.
      if (unified.directAnswer && ctx.steps.length === 0) {
        this.tracer.logEvent(ctx.traceId, 'direct_answer', {
          reason: 'Unified plan included directAnswer — skipping synthesis',
          complexity: unified.complexity,
        });

        this.transitionState(ctx, 'synthesize');
        ctx.result = unified.directAnswer;

        // Constitution: validate output
        if (this.constitution && ctx.result) {
          const outputViolation = this.constitution.validateOutput(ctx.result);
          if (outputViolation) {
            this.tracer.logEvent(ctx.traceId, 'constitution_output_violation', outputViolation as unknown as Record<string, unknown>);
            ctx.result = `[Response filtered by constitution rule ${outputViolation.ruleId}: ${outputViolation.ruleName}]`;
          }
        }

        this.transitionState(ctx, 'done');
        return;
      }

      try {
        this.planner.validatePlan(ctx.plan);
      } catch {
        // Validation errors handled by simulate stage
      }
    } else {
      // Unified planning failed — fall back to separate pipeline (4 LLM calls)
      this.tracer.logEvent(ctx.traceId, 'info', {
        type: 'unified_fallback',
        reason: 'Falling back to separate spec → classify → plan → critique pipeline',
      });

      // SPEC
      this.transitionState(ctx, 'spec');
      ctx.onProgress?.({ phase: 'specifying', usage: this.budget.getUsage(ctx.envelope), state: 'spec' });
      ctx.spec = await this.planner.specifyTask(ctx.task, ctx.envelope, ctx.traceId);

      // CLASSIFY + PLAN
      this.transitionState(ctx, 'plan');
      const complexity = await this.planner.classifyComplexity(ctx.task, ctx.envelope, ctx.traceId);
      this.budget.checkBudget(ctx.envelope);

      ctx.plan = await this.planner.plan(ctx.task, complexity, ctx.envelope, ctx.traceId, ctx.spec);
      this.budget.checkBudget(ctx.envelope);
      try {
        this.planner.validatePlan(ctx.plan);
      } catch {
        // Validation errors handled by simulate stage
      }
      ctx.steps = [...ctx.plan.steps];

      // CRITIQUE
      if (ctx.steps.length > 0) {
        this.transitionState(ctx, 'critique');
        try {
          ctx.planScore = await this.planner.critiquePlan(
            ctx.task, ctx.plan, ctx.spec, ctx.envelope, ctx.traceId,
          );

          if (ctx.planScore.overall < 0.5 && ctx.planScore.refinedPlan?.steps) {
            const refinedPlan = this.planner['parsePlan'](
              JSON.stringify(ctx.planScore.refinedPlan),
              ctx.task.id,
              ctx.plan.complexity,
            );
            this.planner.validatePlan(refinedPlan);
            ctx.plan = refinedPlan;
            ctx.steps = [...refinedPlan.steps];
            ctx.planScore.stepConfidences = ctx.planScore.refinedPlan.steps.map(() => 0.7);
          }
        } catch {
          ctx.planScore = { overall: 0.7, stepConfidences: ctx.steps.map(() => 0.7), issues: [] };
        }
      }
    }

    // SIMULATE → pre-flight validation (static, no LLM calls)
    if (ctx.steps.length > 0) {
      this.transitionState(ctx, 'simulate');
      const simResult = this.simulator.simulate(ctx.plan!);
      ctx.simulationResult = simResult;

      this.tracer.logEvent(ctx.traceId, 'simulation_result', {
        valid: simResult.valid,
        issueCount: simResult.issues.length,
        estimatedCostUsd: simResult.estimatedBudget.estimatedCostUsd,
      });

      for (const issue of simResult.issues) {
        this.tracer.logEvent(ctx.traceId, 'simulation_issue', {
          stepIndex: issue.stepIndex,
          type: issue.type,
          severity: issue.severity,
          message: issue.message,
        });
      }

      // Remove steps with missing tools (they would fail anyway)
      const missingToolIndices = new Set(
        simResult.issues
          .filter(iss => iss.type === 'missing_tool')
          .map(iss => iss.stepIndex),
      );
      if (missingToolIndices.size > 0) {
        ctx.steps = ctx.steps.filter((_, idx) => !missingToolIndices.has(idx));
      }
    }

    // Annotate plan steps with automation strategies for browser tasks
    if (ctx.plan && ctx.steps.length > 0) {
      this.planner.annotatePlanWithStrategies(ctx.task, ctx.plan);
    }

    // ACT → execute steps with reactive planning, verification, and recovery
    this.transitionState(ctx, 'act');
    await this.executeStepsWithVerification(ctx);

    // SYNTHESIZE → generate final answer
    this.transitionState(ctx, 'synthesize');
    ctx.onProgress?.({ phase: 'synthesizing', usage: this.budget.getUsage(ctx.envelope), state: 'synthesize' });
    ctx.result = await this.synthesize(ctx.task, ctx.stepResults, ctx.envelope, ctx.traceId, ctx.speculativeComplexity, ctx.steps);

    // Constitution: validate synthesized output
    if (this.constitution && ctx.result) {
      const outputViolation = this.constitution.validateOutput(ctx.result);
      if (outputViolation) {
        this.tracer.logEvent(ctx.traceId, 'constitution_output_violation', outputViolation as unknown as Record<string, unknown>);
        ctx.result = `[Response filtered by constitution rule ${outputViolation.ruleId}: ${outputViolation.ruleName}]`;
      }
    }

    // DONE
    this.transitionState(ctx, 'done');
  }

  /**
   * Execute steps with the Act → Observe → Verify loop.
   * Each step is executed, then optionally verified. Verification failures
   * trigger retries (bounded) or recovery replanning.
   */
  private async executeStepsWithVerification(ctx: StateMachineContext): Promise<void> {
    // Determine checkpoint interval for long-horizon stability
    const checkpointInterval = Math.max(3, Math.ceil(ctx.steps.length / 3));

    for (let i = 0; i < ctx.steps.length; i++) {
      const step = ctx.steps[i];
      ctx.currentStepIndex = i;
      this.budget.checkBudget(ctx.envelope);

      // Estimate confidence for this step
      const confidence = this.estimateStepConfidence(step, i, ctx);
      this.tracer.logEvent(ctx.traceId, 'confidence_update', {
        stepIndex: i,
        toolName: step.toolName,
        confidence,
      });

      ctx.onProgress?.({
        phase: 'executing',
        stepIndex: i,
        totalSteps: ctx.steps.length,
        usage: this.budget.getUsage(ctx.envelope),
        state: 'act',
      });

      // ACT: execute the step
      const stepResult = await this.executeStep(step, ctx.envelope, ctx.traceId);
      stepResult.confidence = confidence;
      ctx.stepResults.push(stepResult);

      if (stepResult.success) {
        // OBSERVE: reactive planning for browser steps
        try {
          const remainingSteps = ctx.steps.slice(i + 1);
          const reactiveSteps = await this.planner.planReactiveSteps(
            ctx.task, stepResult, ctx.stepResults, remainingSteps, ctx.envelope, ctx.traceId,
          );
          if (reactiveSteps.length > 0) {
            ctx.steps.splice(i + 1, 0, ...reactiveSteps);
          }
        } catch {
          // Reactive planning failed — continue with original plan
        }

        // VERIFY: check step assertions if present
        if (step.verify && step.verify.type !== 'none') {
          this.transitionState(ctx, 'verify');
          ctx.onProgress?.({
            phase: 'verifying',
            stepIndex: i,
            totalSteps: ctx.steps.length,
            usage: this.budget.getUsage(ctx.envelope),
            state: 'verify',
          });

          const verification = await this.verifyStep(step, stepResult, ctx.envelope, ctx.traceId);

          if (!verification.passed) {
            this.tracer.logEvent(ctx.traceId, 'verification_failed', {
              stepIndex: i,
              assertion: step.verify.assertion,
              evidence: verification.evidence,
            });

            // Retry if allowed
            if (step.verify.retryOnFail && ctx.retryCount < (step.verify.maxRetries ?? 2)) {
              ctx.retryCount++;
              this.transitionState(ctx, 'recover');
              ctx.onProgress?.({
                phase: 'recovering',
                stepIndex: i,
                totalSteps: ctx.steps.length,
                usage: this.budget.getUsage(ctx.envelope),
                state: 'recover',
              });

              // Re-execute the same step
              const retryResult = await this.executeStep(step, ctx.envelope, ctx.traceId);
              ctx.stepResults.push(retryResult);
              // Continue regardless — bounded retries prevent infinite loops
            }

            // Reset retry count for next step
            ctx.retryCount = 0;
          } else {
            this.tracer.logEvent(ctx.traceId, 'step_verification', {
              stepIndex: i,
              passed: true,
              evidence: verification.evidence,
            });
            ctx.retryCount = 0;
          }

          // Return to act state for next step
          this.transitionState(ctx, 'act');
        }
      } else {
        // STRATEGY FALLBACK: if browser step failed and has a fallback chain, inject alternative steps
        if (step.strategy && step.strategy.fallbackChain.length > 0) {
          const nextApproach = step.strategy.fallbackChain[0];
          const fallbackSteps = this.buildStrategyFallback(step, nextApproach);

          if (fallbackSteps.length > 0) {
            this.tracer.logEvent(ctx.traceId, 'strategy_selected', {
              stepIndex: i,
              original: step.strategy.primary,
              fallback: nextApproach,
              reason: `${step.strategy.primary} failed: ${stepResult.error}`,
            });

            // Inject fallback steps with remaining fallback chain
            const remainingFallbacks = step.strategy.fallbackChain.slice(1);
            for (const fb of fallbackSteps) {
              fb.strategy = { primary: nextApproach, fallbackChain: remainingFallbacks, reason: `Fallback from ${step.strategy.primary}` };
            }
            ctx.steps.splice(i + 1, 0, ...fallbackSteps);
            continue; // Skip normal recovery — use strategy fallback instead
          }
        }

        // RECOVER: step failed — attempt re-planning
        if (ctx.replanDepth < this.maxReplanDepth && this.budget.canAffordEscalation(ctx.envelope)) {
          this.transitionState(ctx, 'recover');
          ctx.onProgress?.({
            phase: 'recovering',
            stepIndex: i,
            totalSteps: ctx.steps.length,
            usage: this.budget.getUsage(ctx.envelope),
            state: 'recover',
          });

          this.tracer.logEvent(ctx.traceId, 'escalation', {
            reason: `Step ${step.index} failed: ${stepResult.error}`,
            step: step.index,
            replanDepth: ctx.replanDepth,
          });

          try {
            // Dependency-aware pruning: only pass step results relevant to the failed step
            const replanThreshold = this.getAdaptivePruneThreshold(
              ctx.steps, ctx.envelope, ctx.speculativeComplexity ?? 0.5, 0, ctx.replanDepth,
            );
            const { filtered: replanResults, prunedCount: replanPruned, repaired: replanRepaired } =
              this.filterResultsByDependencies(ctx.steps, ctx.stepResults, ctx.task.description, replanThreshold, step.index);
            if (replanPruned > 0 || replanRepaired > 0) {
              this.tracer.logEvent(ctx.traceId, 'dependency_pruning', {
                phase: 'replan',
                totalResults: ctx.stepResults.length,
                prunedCount: replanPruned,
                repairedEdges: replanRepaired,
                keptIndices: replanResults.map(r => r.stepIndex),
              });
            }
            const recoveryPlan = await this.planner.replan(
              ctx.task, step, stepResult.error ?? 'Unknown error', replanResults, ctx.envelope, ctx.traceId,
            );
            this.planner.validatePlan(recoveryPlan);
            this.budget.checkBudget(ctx.envelope);

            // Inject recovery steps and continue
            ctx.replanDepth++;
            const recoverySteps = recoveryPlan.steps;
            ctx.steps.splice(i + 1, ctx.steps.length - i - 1, ...recoverySteps);

            this.transitionState(ctx, 'act');
            continue;
          } catch (replanErr) {
            this.tracer.logEvent(ctx.traceId, 'error', {
              type: 'replan_failed',
              replanDepth: ctx.replanDepth,
              message: replanErr instanceof Error ? replanErr.message : String(replanErr),
            });
            this.transitionState(ctx, 'act');
          }
        } else {
          this.tracer.logEvent(ctx.traceId, 'info', {
            message: `Step ${step.index} failed, no re-plan: ${ctx.replanDepth >= this.maxReplanDepth ? 'max depth reached' : 'no escalation budget'}`,
          });
        }
      }

      // CHECKPOINT: periodic goal alignment check for long-horizon stability
      if (
        ctx.spec &&
        ctx.stepResults.length > 0 &&
        ctx.stepResults.length % checkpointInterval === 0 &&
        i < ctx.steps.length - 1 // Don't checkpoint on the last step
      ) {
        this.transitionState(ctx, 'checkpoint');
        try {
          const checkResult = await this.evaluateGoalCheckpoint(
            ctx.spec, ctx.stepResults, ctx.envelope, ctx.traceId,
          );

          this.tracer.logEvent(ctx.traceId, 'goal_checkpoint', {
            stepIndex: i,
            onTrack: checkResult.onTrack,
            drift: checkResult.drift,
          });

          if (!checkResult.onTrack && ctx.replanDepth < this.maxReplanDepth && this.budget.canAffordEscalation(ctx.envelope)) {
            // Goal drift detected — trigger recovery
            this.transitionState(ctx, 'recover');
            ctx.onProgress?.({
              phase: 'recovering',
              stepIndex: i,
              totalSteps: ctx.steps.length,
              usage: this.budget.getUsage(ctx.envelope),
              state: 'recover',
            });

            try {
              const driftContext = `Goal drift detected: ${checkResult.drift.join('; ')}`;
              const lastStep = ctx.steps[i];
              const recoveryPlan = await this.planner.replan(
                ctx.task, lastStep, driftContext, ctx.stepResults, ctx.envelope, ctx.traceId,
              );
              this.planner.validatePlan(recoveryPlan);
              this.budget.checkBudget(ctx.envelope);
              ctx.replanDepth++;
              ctx.steps.splice(i + 1, ctx.steps.length - i - 1, ...recoveryPlan.steps);
            } catch {
              // Checkpoint replan failed — continue with existing plan
            }
          }
        } catch {
          // Checkpoint evaluation failed — continue
        }
        this.transitionState(ctx, 'act');
      }
    }
  }

  // ─── Confidence Scoring ───

  /**
   * Estimate confidence for a step based on plan critique scores,
   * recent step history, and known failure patterns.
   */
  private estimateStepConfidence(
    step: PlanStep,
    stepIndex: number,
    ctx: StateMachineContext,
  ): number {
    // Base confidence from plan critique
    let confidence = ctx.planScore?.stepConfidences?.[stepIndex] ?? 0.7;

    // Adjust down for recent failures (-0.2 per recent failure, last 3 steps)
    const recentResults = ctx.stepResults.slice(-3);
    for (const r of recentResults) {
      if (!r.success) {
        confidence -= 0.2;
      }
    }

    // Adjust down if this tool appears in known failure patterns
    if (ctx.failurePatterns) {
      const matchingPatterns = ctx.failurePatterns.filter(
        p => p.toolName === step.toolName,
      );
      if (matchingPatterns.length > 0) {
        confidence -= 0.15;
        this.tracer.logEvent(ctx.traceId, 'failure_pattern_match', {
          stepIndex,
          toolName: step.toolName,
          patternCount: matchingPatterns.length,
        });
      }
    }

    // Adjust up if tool succeeded recently (+0.1)
    const recentSuccesses = ctx.stepResults.filter(
      r => r.toolName === step.toolName && r.success,
    );
    if (recentSuccesses.length > 0) {
      confidence += 0.1;
    }

    // Clamp to [0.1, 1.0]
    return Math.max(0.1, Math.min(1.0, confidence));
  }

  // ─── Hybrid Automation Strategy ───

  /**
   * Build fallback steps when a strategy approach fails.
   * Vision: screenshot → mouse click at element coordinates.
   * API: http_fetch if URL can be inferred from tool args.
   */
  private buildStrategyFallback(failedStep: PlanStep, approach: 'dom' | 'vision' | 'api'): PlanStep[] {
    const baseIndex = failedStep.index + 100; // Offset to avoid index collisions

    if (approach === 'vision') {
      // Replace browser action with os_screenshot + os_mouse sequence
      const steps: PlanStep[] = [
        {
          index: baseIndex,
          description: `[Vision fallback] Take screenshot for "${failedStep.description}"`,
          toolName: 'os_screenshot',
          toolArgs: {},
        },
        {
          index: baseIndex + 1,
          description: `[Vision fallback] Click target for "${failedStep.description}"`,
          toolName: 'os_mouse',
          toolArgs: {
            action: 'click',
            x: 0, y: 0, // Placeholder — actual coordinates would need vision model
            button: 'left',
          },
        },
      ];
      return steps;
    }

    if (approach === 'api') {
      // Try to build an http_fetch step from the failed step's context
      const url = (failedStep.toolArgs.url as string) ?? (failedStep.toolArgs.selector as string);
      if (url && /^https?:\/\//.test(url)) {
        return [{
          index: baseIndex,
          description: `[API fallback] Fetch "${url}" directly`,
          toolName: 'http_fetch',
          toolArgs: { url, method: 'GET' },
        }];
      }
      return []; // Can't infer API endpoint
    }

    // DOM fallback — no transformation needed, just retry with different approach
    return [];
  }

  // ─── Long-Horizon Stability ───

  /**
   * Compress step history for long-running tasks to keep context manageable.
   * Preserves first 2 (initial context) and last 3 (recent) steps,
   * summarizes the middle.
   */
  compressStepHistory(stepResults: StepResult[], maxContext = 5): string {
    if (stepResults.length <= maxContext) {
      return stepResults
        .map((r, i) => `Step ${i + 1} (${r.toolName}): ${r.success ? 'OK' : 'FAIL'} — ${JSON.stringify(r.output ?? r.error).slice(0, 200)}`)
        .join('\n');
    }

    const first = stepResults.slice(0, 2);
    const last = stepResults.slice(-3);
    const middle = stepResults.slice(2, -3);
    const middleSucceeded = middle.filter(r => r.success).length;
    const middleFailed = middle.length - middleSucceeded;

    const lines: string[] = [];
    for (const r of first) {
      lines.push(`Step ${r.stepIndex + 1} (${r.toolName}): ${r.success ? 'OK' : 'FAIL'} — ${JSON.stringify(r.output ?? r.error).slice(0, 200)}`);
    }
    lines.push(`... ${middle.length} steps (${middleSucceeded} succeeded, ${middleFailed} failed) ...`);
    for (const r of last) {
      lines.push(`Step ${r.stepIndex + 1} (${r.toolName}): ${r.success ? 'OK' : 'FAIL'} — ${JSON.stringify(r.output ?? r.error).slice(0, 200)}`);
    }
    return lines.join('\n');
  }

  /**
   * Evaluate whether execution is still on track toward the original goal.
   * Uses SLM for fast evaluation.
   */
  private async evaluateGoalCheckpoint(
    spec: TaskSpec,
    stepResults: StepResult[],
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<{ onTrack: boolean; drift: string[] }> {
    const decision = await this.router.route('classify', envelope);
    const provider = this.providers.get(decision.provider);
    if (!provider) {
      return { onTrack: true, drift: [] };
    }

    const compressed = this.compressStepHistory(stepResults);
    const criteriaList = spec.successCriteria
      .map(c => `- ${c.description}`)
      .join('\n');

    const request: ModelRequest = {
      model: decision.model,
      provider: decision.provider,
      tier: decision.tier as ModelTier,
      system: `You are a goal alignment checker. Given a goal, success criteria, and step history, determine if the execution is still on track.
Respond with ONLY a raw JSON object: {"onTrack": true/false, "drift": ["<reason 1>", ...]}
If on track, drift should be an empty array. If drifting, list specific reasons.`,
      messages: [{
        role: 'user',
        content: `Goal: ${spec.goal}\n\nSuccess criteria:\n${criteriaList}\n\nStep history:\n${compressed}\n\nIs execution still on track?`,
      }],
      responseFormat: 'json',
      temperature: 0.1,
    };

    const response = await provider.chat(request);
    this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
    this.budget.deductCost(envelope, response.costUsd);

    try {
      const parsed = JSON.parse(response.content) as { onTrack?: boolean; drift?: string[] };
      return {
        onTrack: parsed.onTrack !== false,
        drift: parsed.drift ?? [],
      };
    } catch {
      return { onTrack: true, drift: [] };
    }
  }

  // ─── Verification ───

  /**
   * Verify a step's result against its assertion.
   * Returns { passed, evidence }.
   */
  private async verifyStep(
    step: PlanStep,
    stepResult: StepResult,
    _envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<{ passed: boolean; evidence?: string }> {
    const verify = step.verify;
    if (!verify || verify.type === 'none') {
      return { passed: true };
    }

    if (verify.type === 'output_check') {
      return this.verifyOutput(verify.assertion, stepResult);
    }

    if (verify.type === 'dom_check') {
      // DOM checks require browser_evaluate — try invoking it
      try {
        const invocation = {
          toolName: 'browser_evaluate',
          input: { script: verify.assertion },
        };

        if (this.tools.has('browser_evaluate')) {
          const evalResult = await this.tools.invoke(invocation);
          this.tracer.logToolCall(traceId, invocation, evalResult);
          const passed = evalResult.success && Boolean(evalResult.output);
          return { passed, evidence: JSON.stringify(evalResult.output) };
        }
      } catch {
        // browser_evaluate unavailable or failed
      }

      // Fallback: treat as output_check
      return this.verifyOutput(verify.assertion, stepResult);
    }

    return { passed: true };
  }

  private verifyOutput(
    assertion: string,
    stepResult: StepResult,
  ): { passed: boolean; evidence?: string } {
    const output = typeof stepResult.output === 'string'
      ? stepResult.output
      : JSON.stringify(stepResult.output ?? '');

    // Try as regex first
    try {
      const regex = new RegExp(assertion, 'i');
      const match = regex.test(output);
      return {
        passed: match,
        evidence: match ? `Output matches pattern "${assertion}"` : `Output does not match pattern "${assertion}"`,
      };
    } catch {
      // Not a valid regex — do case-insensitive contains check
      const contains = output.toLowerCase().includes(assertion.toLowerCase());
      return {
        passed: contains,
        evidence: contains ? `Output contains "${assertion}"` : `Output does not contain "${assertion}"`,
      };
    }
  }

  /**
   * Evaluate all success criteria from the TaskSpec against actual results.
   */
  private evaluateCriteria(
    spec: TaskSpec,
    stepResults: StepResult[],
    result?: string,
  ): CriterionResult[] {
    return spec.successCriteria.map(criterion => {
      switch (criterion.type) {
        case 'output_contains': {
          const pattern = (criterion.check as { pattern?: string }).pattern ?? '';
          const output = result ?? '';
          try {
            const regex = new RegExp(pattern, 'i');
            const met = regex.test(output);
            return { criterion, met, evidence: met ? `Output matches "${pattern}"` : `Output does not match "${pattern}"` };
          } catch {
            const met = output.toLowerCase().includes(pattern.toLowerCase());
            return { criterion, met, evidence: met ? `Output contains "${pattern}"` : `Output does not contain "${pattern}"` };
          }
        }

        case 'tool_succeeded': {
          const toolName = (criterion.check as { toolName?: string }).toolName;
          if (!toolName) {
            // Generic — any step succeeded
            const met = stepResults.some(r => r.success);
            return { criterion, met, evidence: met ? 'At least one step succeeded' : 'No steps succeeded' };
          }
          const met = stepResults.some(r => r.toolName === toolName && r.success);
          return { criterion, met, evidence: met ? `Tool "${toolName}" succeeded` : `Tool "${toolName}" did not succeed` };
        }

        case 'page_state': {
          const urlContains = (criterion.check as { urlContains?: string }).urlContains;
          const titleContains = (criterion.check as { titleContains?: string }).titleContains;
          // Check browser step outputs for URL/title
          const browserResults = stepResults.filter(r => r.toolName.startsWith('browser_') && r.success);
          let met = false;
          let evidence = '';
          for (const br of browserResults) {
            const output = br.output as Record<string, unknown> | undefined;
            if (output) {
              const url = (output.url as string) ?? '';
              const title = (output.title as string) ?? '';
              if (urlContains && url.toLowerCase().includes(urlContains.toLowerCase())) {
                met = true;
                evidence = `URL contains "${urlContains}": ${url}`;
              }
              if (titleContains && title.toLowerCase().includes(titleContains.toLowerCase())) {
                met = true;
                evidence = `Title contains "${titleContains}": ${title}`;
              }
            }
          }
          if (!met) evidence = 'Page state not matched';
          return { criterion, met, evidence };
        }

        case 'file_exists': {
          const path = (criterion.check as { path?: string }).path;
          // Check if file_write or file_read tool succeeded with this path
          const met = stepResults.some(r =>
            (r.toolName === 'file_write' || r.toolName === 'file_read') &&
            r.success &&
            JSON.stringify(r.toolArgs).includes(path ?? ''),
          );
          return { criterion, met, evidence: met ? `File operation on "${path}" succeeded` : `No file operation on "${path}" found` };
        }

        case 'custom':
        default: {
          // Optimistic: if any step succeeded, consider it met
          const met = stepResults.some(r => r.success);
          return { criterion, met, evidence: met ? 'At least one step succeeded' : 'No steps succeeded' };
        }
      }
    });
  }

  // ─── Legacy step execution (preserved for executeStream compatibility) ───

  private async executeStepsWithReplan(
    task: Task,
    plan: ExecutionPlan,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    stepResults: StepResult[],
    onProgress?: ProgressCallback,
    replanDepth = 0,
  ): Promise<void> {
    const steps = [...plan.steps]; // Mutable copy — reactive steps may be injected

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      this.budget.checkBudget(envelope);
      onProgress?.({ phase: 'executing', stepIndex: i, totalSteps: steps.length, usage: this.budget.getUsage(envelope) });

      const stepResult = await this.executeStep(step, envelope, traceId);
      stepResults.push(stepResult);

      if (stepResult.success) {
        // REACTIVE LOOP: after successful browser steps, check for obstacles
        try {
          const remainingSteps = steps.slice(i + 1);
          const reactiveSteps = await this.planner.planReactiveSteps(
            task, stepResult, stepResults, remainingSteps, envelope, traceId,
          );
          if (reactiveSteps.length > 0) {
            // Inject reactive steps right after the current step
            steps.splice(i + 1, 0, ...reactiveSteps);
          }
        } catch {
          // Reactive planning failed — continue with original plan
        }
      } else {
        // Attempt re-planning if budget allows and depth not exceeded
        if (replanDepth < this.maxReplanDepth && this.budget.canAffordEscalation(envelope)) {
          this.tracer.logEvent(traceId, 'escalation', {
            reason: `Step ${step.index} failed: ${stepResult.error}`,
            step: step.index,
            replanDepth,
          });

          try {
            const recoveryPlan = await this.planner.replan(
              task, step, stepResult.error ?? 'Unknown error', stepResults, envelope, traceId,
            );
            this.planner.validatePlan(recoveryPlan);
            this.budget.checkBudget(envelope);

            // Execute recovery plan (recursive, depth incremented)
            await this.executeStepsWithReplan(
              task, recoveryPlan, envelope, traceId, stepResults, onProgress, replanDepth + 1,
            );
            return; // Recovery plan handles remaining work
          } catch (replanErr) {
            // Re-planning itself failed — log and continue with remaining steps
            this.tracer.logEvent(traceId, 'error', {
              type: 'replan_failed',
              replanDepth,
              message: replanErr instanceof Error ? replanErr.message : String(replanErr),
            });
          }
        } else {
          this.tracer.logEvent(traceId, 'info', {
            message: `Step ${step.index} failed, no re-plan: ${replanDepth >= this.maxReplanDepth ? 'max depth reached' : 'no escalation budget'}`,
          });
        }
      }
    }
  }

  private async *executeStepsWithReplanStream(
    task: Task,
    plan: ExecutionPlan,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    stepResults: StepResult[],
    makeProgress: (step: PlanStep, totalSteps: number) => StreamEvent,
    replanDepth = 0,
  ): AsyncGenerator<StreamEvent> {
    const steps = [...plan.steps]; // Mutable copy for reactive step injection

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      this.budget.checkBudget(envelope);
      yield makeProgress(step, steps.length);

      const stepResult = await this.executeStep(step, envelope, traceId);
      stepResults.push(stepResult);

      if (stepResult.success) {
        // REACTIVE LOOP: after successful browser steps, check for obstacles
        try {
          const remainingSteps = steps.slice(i + 1);
          const reactiveSteps = await this.planner.planReactiveSteps(
            task, stepResult, stepResults, remainingSteps, envelope, traceId,
          );
          if (reactiveSteps.length > 0) {
            steps.splice(i + 1, 0, ...reactiveSteps);
          }
        } catch {
          // Reactive planning failed — continue with original plan
        }
      } else if (!stepResult.success) {
        if (replanDepth < this.maxReplanDepth && this.budget.canAffordEscalation(envelope)) {
          this.tracer.logEvent(traceId, 'escalation', {
            reason: `Step ${step.index} failed: ${stepResult.error}`,
            step: step.index,
            replanDepth,
          });

          try {
            const recoveryPlan = await this.planner.replan(
              task, step, stepResult.error ?? 'Unknown error', stepResults, envelope, traceId,
            );
            this.planner.validatePlan(recoveryPlan);
            this.budget.checkBudget(envelope);

            yield* this.executeStepsWithReplanStream(
              task, recoveryPlan, envelope, traceId, stepResults, makeProgress, replanDepth + 1,
            );
            return;
          } catch (replanErr) {
            this.tracer.logEvent(traceId, 'error', {
              type: 'replan_failed',
              replanDepth,
              message: replanErr instanceof Error ? replanErr.message : String(replanErr),
            });
          }
        } else {
          this.tracer.logEvent(traceId, 'info', {
            message: `Step ${step.index} failed, no re-plan: ${replanDepth >= this.maxReplanDepth ? 'max depth reached' : 'no escalation budget'}`,
          });
        }
      }
    }
  }

  private async executeStep(
    step: PlanStep,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<StepResult> {
    const spanId = this.tracer.startSpan(traceId, `step-${step.index}`, {
      tool: step.toolName,
      description: step.description,
    });

    try {
      this.budget.deductToolCall(envelope);

      const invocation = {
        toolName: step.toolName,
        input: step.toolArgs,
      };

      const toolResult = await this.tools.invoke(invocation);
      this.tracer.logToolCall(traceId, invocation, toolResult);

      return {
        stepIndex: step.index,
        toolName: step.toolName,
        toolArgs: step.toolArgs,
        output: toolResult.output,
        success: toolResult.success,
        durationMs: toolResult.durationMs,
        error: toolResult.error,
      };
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  private async synthesize(
    task: Task,
    stepResults: StepResult[],
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    speculativeComplexity?: number,
    steps?: PlanStep[],
  ): Promise<string> {
    const spanId = this.tracer.startSpan(traceId, 'synthesize');

    try {
      // Dependency-aware structural pruning: only include step results the final answer needs
      const synthThreshold = steps
        ? this.getAdaptivePruneThreshold(steps, envelope, speculativeComplexity ?? 0.5, 0, 0)
        : 1.0;
      const { filtered: prunedResults, prunedCount, repaired } = steps
        ? this.filterResultsByDependencies(steps, stepResults, task.description, synthThreshold)
        : { filtered: stepResults, prunedCount: 0, repaired: 0 };
      if (prunedCount > 0 || repaired > 0) {
        this.tracer.logEvent(traceId, 'dependency_pruning', {
          phase: 'synthesize',
          totalResults: stepResults.length,
          prunedCount,
          repairedEdges: repaired,
          keptIndices: prunedResults.map(r => r.stepIndex),
          pruningRate: stepResults.length > 0 ? +(prunedCount / stepResults.length).toFixed(3) : 0,
        });
      }

      const isDirectAnswer = prunedResults.length === 0 && stepResults.length === 0;

      // Speculative routing: use cached complexity from unified plan when available,
      // avoiding redundant complexity estimation for synthesis routing.
      const synthComplexity = speculativeComplexity !== undefined
        ? Math.min(speculativeComplexity, 0.5)  // Synthesis never needs LLM tier
        : (isDirectAnswer ? 0.2 : prunedResults.some(r => !r.success) ? 0.8 : 0.3);

      const decision = await this.router.route('synthesize', envelope, {
        complexity: synthComplexity,
      });
      this.tracer.logRoutingDecision(traceId, decision as unknown as Record<string, unknown>);

      const provider = this.providers.get(decision.provider);
      if (!provider) {
        return isDirectAnswer ? 'I could not process your request.' : prunedResults
          .map((r, i) => `Step ${i + 1} (${r.toolName}): ${r.success ? JSON.stringify(r.output) : `ERROR: ${r.error}`}`)
          .join('\n');
      }

      const messages: ChatMessage[] = [];
      if (task.messages && task.messages.length > 0) {
        messages.push(...task.messages.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })));
      }

      if (isDirectAnswer) {
        messages.push({ role: 'user', content: task.description });
      } else {
        const resultsText = prunedResults
          .map((r) => `Step ${r.stepIndex + 1} (${r.toolName}): ${r.success ? JSON.stringify(r.output) : `ERROR: ${r.error}`}`)
          .join('\n');
        messages.push({
          role: 'user',
          content: `Task: ${task.description}\n\nExecution Results:\n${resultsText}\n\nProvide a clear answer based on these results.`,
        });
      }

      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier as ModelTier,
        system: this.getSynthesizePrompt(isDirectAnswer),
        messages,
        temperature: 0.3,
      };

      const response = await provider.chat(request);
      this.tracer.logModelCall(traceId, request, response);
      this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budget.deductCost(envelope, response.costUsd);
      this.budget.deductEnergy(envelope, response.model, response.tokenUsage, this.energyConfig);

      return response.content;
    } catch {
      return stepResults
        .map((r, i) => `Step ${i + 1}: ${r.success ? JSON.stringify(r.output) : r.error}`)
        .join('\n');
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  private async *synthesizeStream(
    task: Task,
    stepResults: StepResult[],
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    speculativeComplexity?: number,
    steps?: PlanStep[],
  ): AsyncGenerator<StreamChunk> {
    const spanId = this.tracer.startSpan(traceId, 'synthesize-stream');

    try {
      // Dependency-aware structural pruning
      const streamThreshold = steps
        ? this.getAdaptivePruneThreshold(steps, envelope, speculativeComplexity ?? 0.5, 0, 0)
        : 1.0;
      const { filtered: prunedResults, prunedCount, repaired } = steps
        ? this.filterResultsByDependencies(steps, stepResults, task.description, streamThreshold)
        : { filtered: stepResults, prunedCount: 0, repaired: 0 };
      if (prunedCount > 0 || repaired > 0) {
        this.tracer.logEvent(traceId, 'dependency_pruning', {
          phase: 'synthesize-stream',
          totalResults: stepResults.length,
          prunedCount,
          repairedEdges: repaired,
          keptIndices: prunedResults.map(r => r.stepIndex),
          pruningRate: stepResults.length > 0 ? +(prunedCount / stepResults.length).toFixed(3) : 0,
        });
      }

      const isDirectAnswer = prunedResults.length === 0 && stepResults.length === 0;

      const synthComplexity = speculativeComplexity !== undefined
        ? Math.min(speculativeComplexity, 0.5)
        : (isDirectAnswer ? 0.2 : prunedResults.some(r => !r.success) ? 0.8 : 0.3);

      const decision = await this.router.route('synthesize', envelope, {
        complexity: synthComplexity,
      });
      this.tracer.logRoutingDecision(traceId, decision as unknown as Record<string, unknown>);

      const provider = this.providers.get(decision.provider);
      if (!provider) {
        yield { content: isDirectAnswer ? 'I could not process your request.' : prunedResults
          .map((r) => `Step ${r.stepIndex + 1} (${r.toolName}): ${r.success ? JSON.stringify(r.output) : `ERROR: ${r.error}`}`)
          .join('\n'), done: true, finishReason: 'stop' };
        return;
      }

      // Include conversation history for multi-turn context
      const messages: ChatMessage[] = [];
      if (task.messages && task.messages.length > 0) {
        messages.push(...task.messages.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })));
      }

      if (isDirectAnswer) {
        // Direct answer — no tool steps, just answer the question
        messages.push({ role: 'user', content: task.description });
      } else {
        const resultsText = prunedResults
          .map((r) => `Step ${r.stepIndex + 1} (${r.toolName}): ${r.success ? JSON.stringify(r.output) : `ERROR: ${r.error}`}`)
          .join('\n');
        messages.push({
          role: 'user',
          content: `Task: ${task.description}\n\nExecution Results:\n${resultsText}\n\nProvide a clear answer based on these results.`,
        });
      }

      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier as ModelTier,
        system: this.getSynthesizePrompt(isDirectAnswer),
        messages,
        temperature: 0.3,
      };

      let accumulatedContent = '';
      for await (const chunk of provider.chatStream(request)) {
        accumulatedContent += chunk.content;
        yield chunk;

        // Track budget on final chunk
        if (chunk.done && chunk.tokenUsage) {
          const fullUsage = {
            promptTokens: chunk.tokenUsage.promptTokens ?? 0,
            completionTokens: chunk.tokenUsage.completionTokens ?? 0,
            totalTokens: chunk.tokenUsage.totalTokens ?? 0,
          };
          this.budget.deductTokens(envelope, fullUsage.totalTokens, decision.model);
          this.budget.deductEnergy(envelope, decision.model, fullUsage, this.energyConfig);

          this.tracer.logModelCall(traceId, request, {
            model: decision.model,
            provider: decision.provider,
            tier: decision.tier as ModelTier,
            content: accumulatedContent,
            tokenUsage: fullUsage,
            latencyMs: 0,
            costUsd: 0,
            finishReason: 'stop',
          });
        }
      }
    } catch {
      const fallback = stepResults
        .map((r, i) => `Step ${i + 1}: ${r.success ? JSON.stringify(r.output) : r.error}`)
        .join('\n');
      yield { content: fallback, done: true, finishReason: 'stop' };
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  private getSynthesizePrompt(isDirectAnswer: boolean): string {
    const base = isDirectAnswer ? DIRECT_ANSWER_SYSTEM_PROMPT_BASE : SYNTHESIZE_SYSTEM_PROMPT_BASE;
    if (this.constitution) {
      return base + this.constitution.buildPromptInjection();
    }
    return base;
  }
}
