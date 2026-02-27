import type { AgentDefinition, Blackboard, Task, BudgetPresetName, BudgetEnvelope } from '@joule/shared';
import { generateId, isoNow } from '@joule/shared';
import { ToolRegistry } from './tool-registry.js';
import { Planner } from './planner.js';
import type { ModelRouter } from './model-router.js';
import { ModelProviderRegistry } from '@joule/models';
import type { BudgetManager, BudgetEnvelopeInstance } from './budget-manager.js';
import type { TraceLogger } from './trace-logger.js';
import type { ConstitutionEnforcer } from './constitution.js';

/**
 * Per-agent execution context. Bundles the filtered tools, role-aware planner,
 * and enriched task that an agent needs to execute within a crew.
 */
export interface AgentContext {
  agent: AgentDefinition;
  envelope: BudgetEnvelopeInstance;
  filteredTools: ToolRegistry;
  planner: Planner;
  enrichedTask: Task;
}

/**
 * Create an isolated execution context for one agent in a crew.
 * Handles tool filtering, role injection, and blackboard context.
 */
export function createAgentContext(params: {
  agent: AgentDefinition;
  task: Task;
  envelope: BudgetEnvelopeInstance;
  tools: ToolRegistry;
  router: ModelRouter;
  providers: ModelProviderRegistry;
  budgetManager: BudgetManager;
  tracer: TraceLogger;
  blackboard: Blackboard;
  constitution?: ConstitutionEnforcer;
  crewBudget?: BudgetPresetName | Partial<BudgetEnvelope>;
}): AgentContext {
  const {
    agent, task, envelope, tools, router,
    providers, budgetManager, tracer, blackboard, constitution,
    crewBudget,
  } = params;

  // 1. Create filtered tool registry — only agent's allowed tools
  const filteredTools = tools.createFiltered(agent.allowedTools);

  // 2. Create role-aware planner
  const planner = new Planner(
    router,
    filteredTools,
    providers,
    budgetManager,
    tracer,
    {
      constitution,
      agentRole: agent.role,
      agentInstructions: agent.instructions,
    },
  );

  // 3. Build enriched task description
  const blackboardContext = buildBlackboardContext(blackboard, agent.id);
  const enrichedDescription = buildAgentTaskDescription(
    task.description,
    agent,
    blackboardContext,
  );

  const enrichedTask: Task = {
    id: generateId('agent-task'),
    description: enrichedDescription,
    budget: crewBudget ?? task.budget,
    tools: agent.allowedTools,
    createdAt: isoNow(),
    sessionId: task.sessionId,
  };

  return { agent, envelope, filteredTools, planner, enrichedTask };
}

/** Format blackboard entries as context for injection into agent task. */
function buildBlackboardContext(blackboard: Blackboard, currentAgentId: string): string {
  const entries = Object.entries(blackboard.entries)
    .filter(([key]) => key !== currentAgentId);

  if (entries.length === 0) return '';

  const lines = entries.map(([, entry]) => {
    const statusLabel = entry.status ? ` (${entry.status})` : '';
    if (entry.status === 'running') {
      return `[${entry.agentId}${statusLabel}]: (in progress)`;
    }
    const valueStr = typeof entry.value === 'string'
      ? entry.value.slice(0, 500)
      : JSON.stringify(entry.value).slice(0, 500);
    return `[${entry.agentId}${statusLabel}]: ${valueStr}`;
  });

  return `\n\n[Context from other agents]\n${lines.join('\n')}`;
}

/** Build the full task description with agent role and blackboard context. */
function buildAgentTaskDescription(
  originalDescription: string,
  agent: AgentDefinition,
  blackboardContext: string,
): string {
  let description = `[Your Role: ${agent.role}]\n[Instructions: ${agent.instructions}]\n\n[Task]\n${originalDescription}`;

  if (agent.outputSchema) {
    description += `\n\n[Output Format]\nYour response MUST be valid JSON conforming to this schema: ${JSON.stringify(agent.outputSchema)}`;
  }

  if (blackboardContext) {
    description += blackboardContext;
  }

  return description;
}
