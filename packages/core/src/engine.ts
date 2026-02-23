import type { Task, TaskResult, JouleConfig, ToolDefinition, EnergyConfig } from '@joule/shared';
import type { ProgressCallback, StreamEvent } from './task-executor.js';
import { ModelProviderRegistry } from '@joule/models';
import { ConfigManager } from './config-manager.js';
import { BudgetManager } from './budget-manager.js';
import { ModelRouter } from './model-router.js';
import { TraceLogger } from './trace-logger.js';
import { ToolRegistry } from './tool-registry.js';
import { Planner } from './planner.js';
import { TaskExecutor } from './task-executor.js';
import { AgentMemory } from './agent-memory.js';
import { FactExtractor } from './memory/fact-extractor.js';
import { ConstitutionEnforcer } from './constitution.js';
import { DecisionGraphBuilder } from './decision-graph.js';
import { SubTaskOrchestrator } from './sub-task-orchestrator.js';
import { ComputerAgent, type ComputerAgentOptions, type ComputerAgentResult } from './computer-agent.js';

export class Joule {
  readonly config: ConfigManager;
  readonly budget: BudgetManager;
  readonly tracer: TraceLogger;
  readonly tools: ToolRegistry;
  readonly providers: ModelProviderRegistry;
  readonly memory: AgentMemory;

  private router!: ModelRouter;
  private planner!: Planner;
  private executor!: TaskExecutor;
  private factExtractor!: FactExtractor;
  private graphBuilder!: DecisionGraphBuilder;
  private orchestrator!: SubTaskOrchestrator;
  private constitution?: ConstitutionEnforcer;
  private initialized = false;

  constructor(private configOverrides?: Partial<JouleConfig>) {
    this.config = new ConfigManager();
    this.budget = new BudgetManager();
    this.tracer = new TraceLogger();
    this.tools = new ToolRegistry();
    this.providers = new ModelProviderRegistry();
    this.memory = new AgentMemory();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load configuration
    await this.config.load();
    if (this.configOverrides) {
      this.config.set(this.configOverrides);
    }

    // Wire up constitution enforcer (immutable rules)
    const constitutionConfig = this.config.get('constitution');
    this.constitution = new ConstitutionEnforcer(constitutionConfig ?? undefined);
    this.tools.setConstitution(this.constitution);

    // Wire up model router
    const energyConfig = this.config.get('energy');
    this.router = new ModelRouter(
      this.providers,
      this.budget,
      this.config.get('routing'),
      energyConfig,
    );

    // Wire up planner (with constitution for prompt injection)
    this.planner = new Planner(
      this.router,
      this.tools,
      this.providers,
      this.budget,
      this.tracer,
      { constitution: this.constitution },
    );

    // Wire up task executor (with constitution for task/output validation)
    const routingConfig = this.config.get('routing');
    this.executor = new TaskExecutor(
      this.budget,
      this.router,
      this.tracer,
      this.tools,
      this.planner,
      this.providers,
      energyConfig,
      routingConfig,
      this.constitution,
    );

    // Wire up fact extractor for automatic learning
    this.factExtractor = new FactExtractor(this.memory.optimized);

    // Wire up decision graph builder
    this.graphBuilder = new DecisionGraphBuilder();

    // Wire up sub-task orchestrator
    this.orchestrator = new SubTaskOrchestrator(
      this.planner,
      this.budget,
      this.router,
      this.tracer,
      this.tools,
      this.providers,
      energyConfig,
      routingConfig,
      this.constitution,
    );

    // Start background memory consolidation
    this.memory.optimized.startConsolidation();

    this.initialized = true;
  }

  async execute(task: Task, onProgress?: ProgressCallback): Promise<TaskResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Pre-execution: inject memory context into task
    const enrichedTask = await this.enrichTaskWithMemory(task);

    // Execute task
    const result = await this.executor.execute(enrichedTask, onProgress);

    // Post-execution: build decision graph from trace
    try {
      result.decisionGraph = this.graphBuilder.buildFromTrace(task.id, result.trace);
    } catch {
      // Decision graph is best-effort
    }

    // Post-execution: learn from the result
    await this.learnFromResult(task, result);

    return result;
  }

  async *executeStream(task: Task, onProgress?: ProgressCallback): AsyncGenerator<StreamEvent> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Pre-execution: inject memory context
    const enrichedTask = await this.enrichTaskWithMemory(task);

    // Execute and stream
    let finalResult: TaskResult | undefined;
    for await (const event of this.executor.executeStream(enrichedTask, onProgress)) {
      if (event.type === 'result') {
        finalResult = event.result;
      }
      yield event;
    }

    // Post-execution: learn from the result
    if (finalResult) {
      await this.learnFromResult(task, finalResult);
    }
  }

  /** Enrich task with relevant memory context */
  private async enrichTaskWithMemory(task: Task): Promise<Task> {
    try {
      // Prepare working memory with relevant context
      const sessionId = task.sessionId ?? 'default';
      const wm = await this.memory.optimized.prepareContext(sessionId, task.description);
      const contextInjection = this.memory.optimized.buildContextInjection(wm);

      let enrichedDescription = task.description;

      if (contextInjection) {
        enrichedDescription += `\n\n${contextInjection}`;
      }

      // Inject failure patterns for tools that might be used
      try {
        const toolNames = this.tools.listNames();
        const failureContext = await this.memory.optimized.getFailurePatternsForPlanning(toolNames);
        if (failureContext) {
          enrichedDescription += `\n\n[Known Failure Patterns]\n${failureContext}`;
        }
      } catch {
        // Failure pattern injection is best-effort
      }

      if (enrichedDescription !== task.description) {
        return { ...task, description: enrichedDescription };
      }
    } catch {
      // Memory enrichment is best-effort — don't fail the task
    }
    return task;
  }

  /** Learn from a completed task result */
  private async learnFromResult(task: Task, result: TaskResult): Promise<void> {
    try {
      // Record episode
      const toolsUsed = result.stepResults.map(s => s.toolName);
      const episode = await this.memory.optimized.recordEpisode(
        task.id,
        task.description,
        result.status === 'completed' ? 'success' : result.status === 'budget_exhausted' ? 'partial' : 'failed',
        toolsUsed,
        {
          stepsCompleted: result.stepResults.filter(s => s.success).length,
          totalSteps: result.stepResults.length,
          energyUsed: result.efficiencyReport?.actualEnergyWh ?? 0,
          carbonUsed: result.efficiencyReport?.actualCarbonGrams ?? 0,
          costUsd: result.budgetUsed?.costUsd ?? 0,
          tags: toolsUsed,
          context: task.description,
          lessonsLearned: result.status === 'failed' ? result.error : undefined,
        },
      );

      // Auto-extract facts from the interaction
      if (this.factExtractor) {
        await this.factExtractor.learnFromExecution(
          task.description,
          result.result ?? '',
          episode,
        );
      }

      // Extract failure patterns from failed steps
      await this.extractFailurePatterns(task, result);
    } catch {
      // Learning is best-effort — don't fail the task
    }
  }

  /** Extract and store failure patterns from failed steps */
  private async extractFailurePatterns(task: Task, result: TaskResult): Promise<void> {
    const failedSteps = result.stepResults.filter(s => !s.success && s.error);
    if (failedSteps.length === 0) return;

    for (let i = 0; i < failedSteps.length; i++) {
      const step = failedSteps[i];
      const errorSignature = this.normalizeErrorSignature(step.error!);

      // Check if the next step after this failure succeeded (resolution)
      const stepIdx = result.stepResults.indexOf(step);
      const nextStep = result.stepResults[stepIdx + 1];
      const resolution = nextStep?.success
        ? `Recovered with ${nextStep.toolName}: ${JSON.stringify(nextStep.toolArgs).slice(0, 200)}`
        : undefined;

      await this.memory.optimized.storeFailurePattern({
        toolName: step.toolName,
        errorSignature,
        context: task.description.slice(0, 200),
        resolution,
      });
    }
  }

  /** Normalize error messages into reusable signatures by stripping dynamic content */
  private normalizeErrorSignature(error: string): string {
    return error
      // Strip file paths
      .replace(/[A-Z]:\\[\w\\.-]+/gi, '<path>')
      .replace(/\/[\w/.-]+/g, '<path>')
      // Strip UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      // Strip timestamps
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\dZ]*/g, '<timestamp>')
      // Strip large numbers
      .replace(/\b\d{6,}\b/g, '<num>')
      // Strip port numbers in URLs
      .replace(/:\d{4,5}\b/g, ':<port>')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  /**
   * Run the autonomous Computer Agent — observe-think-act loop with vision.
   * The agent takes screenshots, sends them to the LLM, and executes OS-level
   * tools (keyboard, mouse, window management) to complete arbitrary desktop tasks.
   */
  async runAgent(task: string, options?: ComputerAgentOptions): Promise<ComputerAgentResult> {
    if (!this.initialized) {
      await this.initialize();
    }

    const energyConfig = this.config.get('energy');
    const agent = new ComputerAgent(
      this.providers,
      this.tools,
      this.budget,
      this.tracer,
      this.router,
      { energyConfig, ...options },
    );

    const envelope = this.budget.createEnvelope(options?.budget ?? 'high');
    return agent.run(task, envelope);
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.register(tool, 'programmatic');
  }

  async shutdown(): Promise<void> {
    this.memory.optimized.stopConsolidation();
    this.initialized = false;
  }
}
