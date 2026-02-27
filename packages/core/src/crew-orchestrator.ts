import {
  type Task,
  type TaskResult,
  type CrewDefinition,
  type CrewResult,
  type CrewStreamEvent,
  type AgentResult,
  type AgentDefinition,
  type Blackboard,
  type GraphEdge,
  type BudgetUsage,
  type BudgetPresetName,
  type BudgetEnvelope,
  type EnergyConfig,
  type RoutingConfig,
  type ModelRequest,
  type ChatMessage,
  ModelTier,
  generateId,
  isoNow,
} from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import { BudgetManager, type BudgetEnvelopeInstance } from './budget-manager.js';
import { ModelRouter } from './model-router.js';
import { TraceLogger } from './trace-logger.js';
import { ToolRegistry } from './tool-registry.js';
import { Planner } from './planner.js';
import { TaskExecutor, type ProgressCallback } from './task-executor.js';
import { DirectExecutor } from './direct-executor.js';
import type { AgentMemory } from './agent-memory.js';
import type { ConstitutionEnforcer } from './constitution.js';
import { createAgentContext } from './agent-context.js';

const MANAGER_DELEGATION_PROMPT = `You are the manager agent. Analyze the task and delegate to your workers.

Available workers:
{WORKERS}

Respond with ONLY a raw JSON object (no markdown, no code fences):
{"delegations": [{"agentId": "<worker_id>", "instructions": "<what this worker should do>"}], "synthesis": "<how to combine results>"}`;

const MANAGER_SYNTHESIS_PROMPT = `You are the manager agent. Synthesize the results from your workers into a single coherent answer.

Worker results:
{RESULTS}

Provide a comprehensive final answer that combines the best of each worker's output.`;

/**
 * Orchestrates multi-agent crew execution with 4 strategies:
 * sequential, parallel, hierarchical, and graph (DAG with conditions).
 *
 * Each agent gets:
 * - Its own budget sub-envelope (parent mirroring propagates totals)
 * - A filtered ToolRegistry (only its allowed tools)
 * - Blackboard access for inter-agent context passing
 * - Agent-specific system prompt injection via a per-agent Planner
 *
 * The ONLY multi-agent framework with 7-dimension budget enforcement.
 */
export class CrewOrchestrator {
  constructor(
    private planner: Planner,
    private budget: BudgetManager,
    private router: ModelRouter,
    private tracer: TraceLogger,
    private tools: ToolRegistry,
    private providers: ModelProviderRegistry,
    private memory?: AgentMemory,
    private energyConfig?: EnergyConfig,
    private routingConfig?: RoutingConfig,
    private constitution?: ConstitutionEnforcer,
  ) {}

  /** Active crew budget — set at start of executeCrew, used by agent context factory. */
  private activCrewBudget?: BudgetPresetName | Partial<BudgetEnvelope>;

  /** Active orchestration strategy — sequential agents get extra retries. */
  private activeStrategy?: string;

  /**
   * Execute a crew of agents against a task using the crew's orchestration strategy.
   */
  async executeCrew(
    crew: CrewDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
    onProgress?: ProgressCallback,
  ): Promise<CrewResult> {
    // Store crew budget so agent tasks inherit it instead of defaulting to 'medium'
    this.activCrewBudget = crew.budget;
    this.activeStrategy = crew.strategy;

    // Trace
    const spanId = this.tracer.startSpan(traceId, 'crew-execution', {
      crewName: crew.name,
      strategy: crew.strategy,
      agentCount: crew.agents?.length ?? 0,
    });

    const blackboard: Blackboard = { entries: {} };
    let agentResults: AgentResult[] = [];
    let error: string | undefined;

    try {
      // Validate (inside try so errors produce a 'failed' result)
      this.validateCrew(crew);
      switch (crew.strategy) {
        case 'sequential':
          agentResults = await this.executeSequential(crew, task, parentEnvelope, traceId, blackboard, onProgress);
          break;
        case 'parallel':
          agentResults = await this.executeParallel(crew, task, parentEnvelope, traceId, blackboard, onProgress);
          break;
        case 'hierarchical':
          agentResults = await this.executeHierarchical(crew, task, parentEnvelope, traceId, blackboard, onProgress);
          break;
        case 'graph':
          agentResults = await this.executeGraph(crew, task, parentEnvelope, traceId, blackboard, onProgress);
          break;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    this.tracer.endSpan(traceId, spanId);

    // Determine status
    const completedCount = agentResults.filter(r => r.taskResult.status === 'completed').length;
    const status: CrewResult['status'] = error
      ? 'failed'
      : completedCount === agentResults.length
        ? 'completed'
        : completedCount > 0
          ? 'partial'
          : 'failed';

    // Aggregate final result
    let result: string | undefined;
    try {
      result = await this.aggregateResults(crew, agentResults, parentEnvelope, traceId);
    } catch {
      result = agentResults.map(r => r.taskResult.result ?? '').filter(Boolean).join('\n\n');
    }

    // Build budget usage from parent envelope
    const budgetUsed = this.budget.getUsage(parentEnvelope);

    return {
      id: generateId('crew-result'),
      crewName: crew.name,
      status,
      result,
      agentResults,
      budgetUsed,
      trace: this.tracer.getTrace(traceId, budgetUsed),
      blackboard,
      completedAt: isoNow(),
      error,
    };
  }

  /**
   * Stream crew execution events as an async generator.
   * Yields agent-start, agent-progress, agent-complete, agent-error, and crew-complete events.
   */
  async *executeCrewStream(
    crew: CrewDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
  ): AsyncGenerator<CrewStreamEvent, CrewResult, undefined> {
    // Collect events from the progress callback
    const eventQueue: CrewStreamEvent[] = [];
    let resolveWaiting: (() => void) | undefined;

    const onProgress: ProgressCallback = (event) => {
      eventQueue.push({
        type: 'agent-progress',
        agentId: event.agentId,
        agentRole: event.agentRole,
        progress: { phase: event.phase, stepIndex: event.stepIndex, totalSteps: event.totalSteps },
        timestamp: isoNow(),
      });
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = undefined;
      }
    };

    // Run executeCrew in the background while yielding events
    const crewPromise = this.executeCrew(crew, task, parentEnvelope, traceId, onProgress);

    // Yield agent-start events for each agent
    for (const agent of crew.agents) {
      yield {
        type: 'agent-start' as const,
        agentId: agent.id,
        agentRole: agent.role,
        timestamp: isoNow(),
      };
    }

    // Drain event queue while crew is executing
    let crewResult: CrewResult | undefined;
    let crewDone = false;

    crewPromise.then(result => {
      crewResult = result;
      crewDone = true;
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = undefined;
      }
    }).catch(() => {
      crewDone = true;
      if (resolveWaiting) {
        resolveWaiting();
        resolveWaiting = undefined;
      }
    });

    while (!crewDone || eventQueue.length > 0) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else if (!crewDone) {
        await new Promise<void>(r => { resolveWaiting = r; });
      }
    }

    // Yield per-agent completion events
    if (crewResult) {
      for (const agentResult of crewResult.agentResults) {
        const eventType = agentResult.taskResult.status === 'completed' ? 'agent-complete' : 'agent-error';
        yield {
          type: eventType as CrewStreamEvent['type'],
          agentId: agentResult.agentId,
          agentRole: agentResult.role,
          agentResult,
          timestamp: isoNow(),
        };
      }

      // Final crew-complete event
      yield {
        type: 'crew-complete' as const,
        crewResult,
        timestamp: isoNow(),
      };

      return crewResult;
    }

    // Fallback: crew failed entirely
    const failedResult: CrewResult = {
      id: generateId('crew-result'),
      crewName: crew.name,
      status: 'failed',
      agentResults: [],
      budgetUsed: this.budget.getUsage(parentEnvelope),
      trace: this.tracer.getTrace(traceId, this.budget.getUsage(parentEnvelope)),
      blackboard: { entries: {} },
      completedAt: isoNow(),
      error: 'Crew execution failed',
    };

    yield {
      type: 'crew-complete' as const,
      crewResult: failedResult,
      timestamp: isoNow(),
    };

    return failedResult;
  }

  // ---------------------------------------------------------------------------
  // Strategy: Sequential — agents run one after another in pipeline order
  // ---------------------------------------------------------------------------

  private async executeSequential(
    crew: CrewDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const orderedAgents = this.resolveAgentOrder(crew);

    // Pre-allocate fair budget envelopes for ALL agents up front (same algorithm
    // as parallel strategy).  This prevents later agents from being budget-starved
    // because earlier agents consumed tokens from the shared parent.
    const envelopes = this.allocateBudgets(orderedAgents, parentEnvelope);

    for (const agent of orderedAgents) {
      const spanId = this.tracer.startSpan(traceId, `agent-${agent.id}`);

      // Mark agent as running on the blackboard
      this.writeToBlackboard(blackboard, agent.id, null, 'running');

      const envelope = envelopes.get(agent.id)!;
      let agentResult: AgentResult;

      try {
        agentResult = await this.executeAgentWithRetry(
          agent, task, envelope, traceId, blackboard, onProgress,
        );
      } catch (err) {
        // Never let a single agent exception kill the pipeline
        agentResult = this.failedAgentResult(agent, err);
      }

      results.push(agentResult);

      // Write result to blackboard with final status
      const status = agentResult.taskResult.status === 'completed' ? 'completed' : 'failed';
      this.writeToBlackboard(blackboard, agent.id, agentResult.taskResult.result, status);

      this.tracer.endSpan(traceId, spanId);

      // Continue pipeline even on failure — downstream agents may still succeed
      // with context from the agents that did complete.
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Strategy: Parallel — all agents run concurrently
  // ---------------------------------------------------------------------------

  private async executeParallel(
    crew: CrewDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult[]> {
    // Pre-allocate all budget envelopes before execution starts
    const envelopes = this.allocateBudgets(crew.agents, parentEnvelope);

    // Mark all agents as running
    for (const agent of crew.agents) {
      this.writeToBlackboard(blackboard, agent.id, null, 'running');
    }

    const promises = crew.agents.map(async (agent) => {
      const spanId = this.tracer.startSpan(traceId, `agent-${agent.id}`);
      const envelope = envelopes.get(agent.id)!;

      const agentResult = await this.executeAgentWithRetry(
        agent, task, envelope, traceId, blackboard, onProgress,
      );

      this.tracer.endSpan(traceId, spanId);
      return agentResult;
    });

    const settled = await Promise.allSettled(promises);
    const results: AgentResult[] = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      const agent = crew.agents[i];

      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
        const status = outcome.value.taskResult.status === 'completed' ? 'completed' : 'failed';
        this.writeToBlackboard(blackboard, agent.id, outcome.value.taskResult.result, status as 'completed' | 'failed');
      } else {
        results.push(this.failedAgentResult(agent, outcome.reason));
        this.writeToBlackboard(blackboard, agent.id, null, 'failed');
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Strategy: Hierarchical — manager delegates to workers, then synthesizes
  // ---------------------------------------------------------------------------

  private async executeHierarchical(
    crew: CrewDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    const orderedAgents = this.resolveAgentOrder(crew);
    const manager = orderedAgents[0];
    const workers = orderedAgents.slice(1);

    if (!manager) return results;

    // Phase 1: Manager planning — use 30% of manager's budget
    const managerShare = manager.budgetShare ?? (1 / crew.agents.length);
    const planningAgent: AgentDefinition = {
      ...manager,
      budgetShare: managerShare * 0.3,
      instructions: manager.instructions + '\n\n' + MANAGER_DELEGATION_PROMPT.replace(
        '{WORKERS}',
        workers.map(w => `- ${w.id} (${w.role}): ${w.instructions.slice(0, 100)}`).join('\n'),
      ),
    };

    const planSpanId = this.tracer.startSpan(traceId, `agent-${manager.id}-plan`);
    const planResult = await this.executeAgent(
      planningAgent, task, parentEnvelope, traceId, blackboard, onProgress,
    );
    results.push(planResult);
    this.writeToBlackboard(blackboard, `${manager.id}_plan`, planResult.taskResult.result);
    this.tracer.endSpan(traceId, planSpanId);

    // Parse delegation plan (best-effort)
    let delegationOrder = workers.map(w => w.id);
    try {
      const parsed = JSON.parse(planResult.taskResult.result ?? '{}') as {
        delegations?: Array<{ agentId: string }>;
      };
      if (parsed.delegations && parsed.delegations.length > 0) {
        const validIds = new Set(workers.map(w => w.id));
        const ordered = parsed.delegations
          .map(d => d.agentId)
          .filter(id => validIds.has(id));
        if (ordered.length > 0) delegationOrder = ordered;
      }
    } catch {
      // Fall back to definition order
    }

    // Phase 2: Worker execution in manager-specified order
    const workerMap = new Map(workers.map(w => [w.id, w]));
    for (const workerId of delegationOrder) {
      const worker = workerMap.get(workerId);
      if (!worker) continue;

      const workerSpanId = this.tracer.startSpan(traceId, `agent-${worker.id}`);
      const workerResult = await this.executeAgent(
        worker, task, parentEnvelope, traceId, blackboard, onProgress,
      );
      results.push(workerResult);
      this.writeToBlackboard(blackboard, worker.id, workerResult.taskResult.result);
      this.tracer.endSpan(traceId, workerSpanId);
    }

    // Phase 3: Manager synthesis — use remaining 70% of manager's budget
    const workerResultsSummary = results
      .slice(1) // Skip manager plan result
      .map(r => `[${r.role}]: ${(r.taskResult.result ?? '').slice(0, 500)}`)
      .join('\n\n');

    const synthesisAgent: AgentDefinition = {
      ...manager,
      budgetShare: managerShare * 0.7,
      instructions: manager.instructions + '\n\n' + MANAGER_SYNTHESIS_PROMPT.replace(
        '{RESULTS}',
        workerResultsSummary,
      ),
    };

    const synthSpanId = this.tracer.startSpan(traceId, `agent-${manager.id}-synthesize`);
    const synthResult = await this.executeAgent(
      synthesisAgent, task, parentEnvelope, traceId, blackboard, onProgress,
    );
    results.push(synthResult);
    this.writeToBlackboard(blackboard, `${manager.id}_synthesis`, synthResult.taskResult.result);
    this.tracer.endSpan(traceId, synthSpanId);

    return results;
  }

  // ---------------------------------------------------------------------------
  // Strategy: Graph — DAG execution with conditional edges
  // ---------------------------------------------------------------------------

  private async executeGraph(
    crew: CrewDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult[]> {
    const edges = crew.graph ?? [];
    const agentMap = new Map(crew.agents.map(a => [a.id, a]));
    const agentResultMap = new Map<string, AgentResult>();
    const results: AgentResult[] = [];

    // Topological sort into layers
    const layers = this.topologicalSortLayers(crew.agents, edges);

    for (const layer of layers) {
      // Evaluate conditions and filter agents in this layer
      const eligible = layer.filter(agent => {
        const incomingEdges = edges.filter(e => e.to === agent.id);
        return incomingEdges.every(edge => {
          if (!edge.condition) return true;
          return this.evaluateCondition(edge.condition, blackboard, agentResultMap);
        });
      });

      if (eligible.length === 0) continue;

      if (eligible.length === 1) {
        // Single agent — run directly
        const agent = eligible[0];
        const spanId = this.tracer.startSpan(traceId, `agent-${agent.id}`);
        const result = await this.executeAgent(
          agent, task, parentEnvelope, traceId, blackboard, onProgress,
        );
        results.push(result);
        agentResultMap.set(agent.id, result);
        this.writeToBlackboard(blackboard, agent.id, result.taskResult.result);
        this.tracer.endSpan(traceId, spanId);
      } else {
        // Multiple agents in layer — run concurrently
        const envelopes = this.allocateBudgets(eligible, parentEnvelope);
        const promises = eligible.map(async (agent) => {
          const spanId = this.tracer.startSpan(traceId, `agent-${agent.id}`);
          const envelope = envelopes.get(agent.id)!;
          const result = await this.executeAgentWithRetry(
            agent, task, envelope, traceId, blackboard, onProgress,
          );
          this.tracer.endSpan(traceId, spanId);
          return { agent, result };
        });

        const settled = await Promise.allSettled(promises);
        for (const outcome of settled) {
          if (outcome.status === 'fulfilled') {
            const { agent, result } = outcome.value;
            results.push(result);
            agentResultMap.set(agent.id, result);
            const status = result.taskResult.status === 'completed' ? 'completed' : 'failed';
            this.writeToBlackboard(blackboard, agent.id, result.taskResult.result, status as 'completed' | 'failed');
          }
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Core: Execute a single agent
  // ---------------------------------------------------------------------------

  private async executeAgent(
    agent: AgentDefinition,
    task: Task,
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult> {
    const envelope = this.budget.createSubEnvelope(
      parentEnvelope,
      agent.budgetShare ?? (1 / 3),
    );

    return this.executeAgentWithRetry(
      agent, task, envelope, traceId, blackboard, onProgress,
    );
  }

  /**
   * Execute an agent with retry logic. Retries on failure with exponential backoff.
   * Sequential agents get a minimum of 2 retries by default to maximise pipeline success.
   * Skips retry on budget exhaustion errors (won't help).
   */
  private async executeAgentWithRetry(
    agent: AgentDefinition,
    task: Task,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult> {
    const sequentialMinRetries = this.activeStrategy === 'sequential' ? 2 : 0;
    const maxRetries = agent.maxRetries ?? sequentialMinRetries;
    const baseDelay = agent.retryDelayMs ?? 1000;
    let lastResult: AgentResult | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let result: AgentResult;

      try {
        result = await this.executeAgentWithEnvelope(
          agent, task, envelope, traceId, blackboard, onProgress,
        );
      } catch (err) {
        // Catch unexpected exceptions (JSON parse, provider errors, etc.)
        result = this.failedAgentResult(agent, err);
      }

      if (result.taskResult.status === 'completed') {
        // Check structured output schema if defined
        if (agent.outputSchema && !this.validateAgentOutput(result.taskResult.result, agent.outputSchema)) {
          lastResult = result;
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
            continue;
          }
          return lastResult;
        }
        return result;
      }

      lastResult = result;

      // Don't retry on budget exhaustion — it won't help
      if (result.taskResult.error?.includes('budget') || result.taskResult.error?.includes('Budget')) {
        break;
      }

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }

    return lastResult!;
  }

  private async executeAgentWithEnvelope(
    agent: AgentDefinition,
    task: Task,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    blackboard: Blackboard,
    onProgress?: ProgressCallback,
  ): Promise<AgentResult> {
    const ctx = createAgentContext({
      agent,
      task,
      envelope,
      tools: this.tools,
      router: this.router,
      providers: this.providers,
      budgetManager: this.budget,
      tracer: this.tracer,
      blackboard,
      constitution: this.constitution,
      crewBudget: this.activCrewBudget,
    });

    // Wrap progress callback with agent identity
    const wrappedProgress: ProgressCallback | undefined = onProgress
      ? (event) => onProgress({ ...event, agentId: agent.id, agentRole: agent.role })
      : undefined;

    // Choose execution mode: 'direct' (fast reactive loop) or 'full' (7-phase pipeline)
    const executionMode = agent.executionMode ?? 'direct';

    let taskResult;

    if (executionMode === 'direct') {
      // OpenClaw-style: single LLM call in a tight tool-use loop (1-3 calls)
      const directExecutor = new DirectExecutor(
        this.budget,
        this.router,
        ctx.filteredTools,
        this.providers,
      );
      taskResult = await directExecutor.execute(
        ctx.enrichedTask, envelope, agent, wrappedProgress,
      );
    } else {
      // Full 7-phase pipeline (4+ LLM calls)
      const executor = new TaskExecutor(
        this.budget,
        this.router,
        this.tracer,
        ctx.filteredTools,
        ctx.planner,
        this.providers,
        this.energyConfig,
        this.routingConfig,
        this.constitution,
      );
      taskResult = await executor.execute(ctx.enrichedTask, wrappedProgress);

      // Mirror agent spending to the crew sub-envelope so it propagates upward.
      // TaskExecutor creates its own internal envelope, so we manually reflect
      // the tokens/cost here.
      if (taskResult.budgetUsed) {
        this.budget.deductTokens(envelope, taskResult.budgetUsed.tokensUsed, 'crew-agent');
        this.budget.deductCost(envelope, taskResult.budgetUsed.costUsd);
      }
    }

    return {
      agentId: agent.id,
      role: agent.role,
      taskResult,
      budgetUsed: taskResult.budgetUsed ?? this.budget.getUsage(envelope),
      blackboardWrites: [agent.id],
    };
  }

  // ---------------------------------------------------------------------------
  // Blackboard management
  // ---------------------------------------------------------------------------

  private writeToBlackboard(
    blackboard: Blackboard,
    agentId: string,
    value: unknown,
    status: 'pending' | 'running' | 'completed' | 'failed' = 'completed',
    metadata?: { confidence?: number; tags?: string[]; format?: string },
  ): void {
    blackboard.entries[agentId] = {
      agentId,
      value,
      timestamp: isoNow(),
      status,
      metadata,
    };
  }

  // ---------------------------------------------------------------------------
  // Budget allocation (parallel-safe)
  // ---------------------------------------------------------------------------

  /**
   * Pre-allocate budget envelopes for all agents from a parent envelope.
   * Compensates for the sequential reduction in createSubEnvelope by computing
   * relative shares that produce the correct absolute amounts.
   */
  private allocateBudgets(
    agents: AgentDefinition[],
    parentEnvelope: BudgetEnvelopeInstance,
  ): Map<string, BudgetEnvelopeInstance> {
    const envelopes = new Map<string, BudgetEnvelopeInstance>();

    // Normalize shares
    const shares = new Map<string, number>();
    let totalExplicit = 0;
    let unspecifiedCount = 0;

    for (const agent of agents) {
      if (agent.budgetShare !== undefined) {
        totalExplicit += agent.budgetShare;
      } else {
        unspecifiedCount++;
      }
    }

    const remaining = Math.max(0, 1.0 - totalExplicit);
    const defaultShare = unspecifiedCount > 0 ? remaining / unspecifiedCount : 0;

    let rawTotal = 0;
    for (const agent of agents) {
      const share = agent.budgetShare ?? defaultShare;
      shares.set(agent.id, share);
      rawTotal += share;
    }

    // Normalize if total exceeds 1.0
    const normalizer = rawTotal > 1.0 ? 1.0 / rawTotal : 1.0;

    // Allocate with sequential-reduction compensation
    // Sort ascending so smaller shares go first (minimizes rounding error)
    const sorted = [...agents].sort(
      (a, b) => (shares.get(a.id) ?? 0) - (shares.get(b.id) ?? 0),
    );

    let allocated = 0;
    for (const agent of sorted) {
      const normalizedShare = (shares.get(agent.id) ?? defaultShare) * normalizer;
      const denominator = 1 - allocated;
      const relativeShare = denominator > 0
        ? Math.min(1.0, normalizedShare / denominator)
        : 1.0;

      const envelope = this.budget.createSubEnvelope(parentEnvelope, relativeShare);
      envelopes.set(agent.id, envelope);
      allocated += normalizedShare;
    }

    return envelopes;
  }

  // ---------------------------------------------------------------------------
  // Agent ordering
  // ---------------------------------------------------------------------------

  private resolveAgentOrder(crew: CrewDefinition): AgentDefinition[] {
    if (!crew.agentOrder || crew.agentOrder.length === 0) {
      return crew.agents;
    }

    const agentMap = new Map(crew.agents.map(a => [a.id, a]));
    const ordered: AgentDefinition[] = [];

    for (const id of crew.agentOrder) {
      const agent = agentMap.get(id);
      if (agent) ordered.push(agent);
    }

    // Append any agents not in agentOrder
    for (const agent of crew.agents) {
      if (!ordered.includes(agent)) {
        ordered.push(agent);
      }
    }

    return ordered;
  }

  // ---------------------------------------------------------------------------
  // Graph utilities
  // ---------------------------------------------------------------------------

  /**
   * Topological sort agents into layers. Agents in the same layer have
   * no dependencies between them and can run concurrently.
   */
  private topologicalSortLayers(
    agents: AgentDefinition[],
    edges: GraphEdge[],
  ): AgentDefinition[][] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const agent of agents) {
      inDegree.set(agent.id, 0);
      adjacency.set(agent.id, []);
    }

    for (const edge of edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
      const adj = adjacency.get(edge.from);
      if (adj) adj.push(edge.to);
    }

    const agentMap = new Map(agents.map(a => [a.id, a]));
    const layers: AgentDefinition[][] = [];
    const placed = new Set<string>();

    // Find all nodes with in-degree 0
    let queue = agents.filter(a => (inDegree.get(a.id) ?? 0) === 0);

    while (queue.length > 0) {
      layers.push(queue);
      for (const agent of queue) {
        placed.add(agent.id);
      }

      const nextQueue: AgentDefinition[] = [];
      for (const agent of queue) {
        for (const neighborId of (adjacency.get(agent.id) ?? [])) {
          const newDegree = (inDegree.get(neighborId) ?? 1) - 1;
          inDegree.set(neighborId, newDegree);
          if (newDegree === 0) {
            const neighbor = agentMap.get(neighborId);
            if (neighbor) nextQueue.push(neighbor);
          }
        }
      }

      queue = nextQueue;
    }

    // Cycle detection
    if (placed.size < agents.length) {
      const unplaced = agents.filter(a => !placed.has(a.id)).map(a => a.id);
      throw new Error(`Cycle detected in crew graph involving agents: ${unplaced.join(', ')}`);
    }

    return layers;
  }

  /**
   * Evaluate a graph edge condition against blackboard state and agent results.
   * Uses pattern matching only — NO eval().
   */
  private evaluateCondition(
    condition: string,
    blackboard: Blackboard,
    agentResults: Map<string, AgentResult>,
  ): boolean {
    // Pattern: 'agent_id.status === "completed"'
    const statusMatch = condition.match(/^(\w+)\.status\s*===?\s*["'](\w+)["']$/);
    if (statusMatch) {
      const [, agentId, expectedStatus] = statusMatch;
      const result = agentResults.get(agentId);
      return result?.taskResult.status === expectedStatus;
    }

    // Pattern: 'blackboard.key === "value"'
    const bbEqMatch = condition.match(/^blackboard\.(\w+)\s*===?\s*["'](.+)["']$/);
    if (bbEqMatch) {
      const [, key, expectedValue] = bbEqMatch;
      return String(blackboard.entries[key]?.value) === expectedValue;
    }

    // Pattern: 'blackboard.key' (truthy check)
    const bbTruthyMatch = condition.match(/^blackboard\.(\w+)$/);
    if (bbTruthyMatch) {
      const [, key] = bbTruthyMatch;
      return key in blackboard.entries && blackboard.entries[key].value != null;
    }

    // Unknown pattern — fail open
    return true;
  }

  // ---------------------------------------------------------------------------
  // Result aggregation
  // ---------------------------------------------------------------------------

  private async aggregateResults(
    crew: CrewDefinition,
    agentResults: AgentResult[],
    parentEnvelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<string> {
    if (agentResults.length === 0) return 'No agents executed.';

    const mode = crew.aggregation ?? 'concat';

    if (mode === 'last') {
      return agentResults[agentResults.length - 1].taskResult.result ?? 'Completed.';
    }

    if (mode === 'concat') {
      return agentResults
        .map(r => `[${r.role} (${r.agentId})]: ${r.taskResult.result ?? (r.taskResult.status === 'completed' ? 'Completed' : `Failed: ${r.taskResult.error ?? 'unknown'}`)}`)
        .join('\n\n');
    }

    // mode === 'custom' — use LLM to synthesize
    if (!crew.aggregationPrompt) {
      // Fall back to concat
      return agentResults
        .map(r => `[${r.role}]: ${r.taskResult.result ?? 'Completed'}`)
        .join('\n\n');
    }

    try {
      const resultsText = agentResults
        .map(r => `[${r.role}]: ${(r.taskResult.result ?? '').slice(0, 500)}`)
        .join('\n\n');

      const decision = await this.router.route('synthesize', parentEnvelope, { complexity: 0.5 });
      const provider = this.providers.get(decision.provider);
      if (!provider) {
        return agentResults.map(r => r.taskResult.result ?? '').join('\n\n');
      }

      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier as ModelTier,
        system: crew.aggregationPrompt,
        messages: [{
          role: 'user' as const,
          content: `Agent results:\n\n${resultsText}`,
        } satisfies ChatMessage],
        temperature: 0.3,
      };

      const response = await provider.chat(request);
      this.budget.deductTokens(parentEnvelope, response.tokenUsage.totalTokens, response.model);
      this.budget.deductCost(parentEnvelope, response.costUsd);

      return response.content;
    } catch {
      return agentResults.map(r => r.taskResult.result ?? '').join('\n\n');
    }
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validateCrew(crew: CrewDefinition): void {
    if (!crew.agents || crew.agents.length === 0) {
      throw new Error('Crew must have at least one agent');
    }

    // Check unique IDs
    const ids = new Set<string>();
    for (const agent of crew.agents) {
      if (ids.has(agent.id)) {
        throw new Error(`Duplicate agent ID: ${agent.id}`);
      }
      ids.add(agent.id);
    }

    // Check budget shares sum
    const totalShare = crew.agents
      .filter(a => a.budgetShare !== undefined)
      .reduce((sum, a) => sum + a.budgetShare!, 0);
    if (totalShare > 1.0 + 0.001) {
      throw new Error(`Agent budget shares sum to ${totalShare.toFixed(2)}, exceeds 1.0`);
    }

    // Validate graph edges reference valid agents
    if (crew.strategy === 'graph' && crew.graph) {
      for (const edge of crew.graph) {
        if (!ids.has(edge.from)) {
          throw new Error(`Graph edge references unknown agent: ${edge.from}`);
        }
        if (!ids.has(edge.to)) {
          throw new Error(`Graph edge references unknown agent: ${edge.to}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Validate agent output against a JSON schema (lightweight key-existence check).
   */
  private validateAgentOutput(output: string | undefined, schema: Record<string, unknown>): boolean {
    if (!output) return false;
    try {
      const parsed = JSON.parse(output);
      const properties = schema.properties as Record<string, unknown> | undefined;
      const requiredKeys = (schema.required as string[]) ?? Object.keys(properties ?? {});
      return requiredKeys.every(key => key in parsed);
    } catch {
      return false;
    }
  }

  private failedAgentResult(agent: AgentDefinition, error: unknown): AgentResult {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      agentId: agent.id,
      role: agent.role,
      taskResult: {
        id: generateId('result'),
        taskId: '',
        traceId: '',
        status: 'failed',
        result: undefined,
        stepResults: [],
        budgetUsed: {
          tokensUsed: 0, tokensRemaining: 0,
          toolCallsUsed: 0, toolCallsRemaining: 0,
          escalationsUsed: 0, escalationsRemaining: 0,
          costUsd: 0, costRemaining: 0,
          elapsedMs: 0, latencyRemaining: 0,
        },
        trace: { traceId: '', taskId: '', startedAt: '', completedAt: '', totalDurationMs: 0, budget: { allocated: {} as any, used: {} as any }, spans: [] },
        error: errorMsg,
        completedAt: isoNow(),
      },
      budgetUsed: {
        tokensUsed: 0, tokensRemaining: 0,
        toolCallsUsed: 0, toolCallsRemaining: 0,
        escalationsUsed: 0, escalationsRemaining: 0,
        costUsd: 0, costRemaining: 0,
        elapsedMs: 0, latencyRemaining: 0,
      },
      blackboardWrites: [],
    };
  }
}
