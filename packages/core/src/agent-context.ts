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
    // Identity for instrumentation: every agent in the crew runs its own
    // lifecycle, all of them under the task the crew was given.
    agentId: agent.id,
    agentRole: agent.role,
    parentTaskId: task.id,
    ...(task.verifiedEdit ? { verifiedEdit: task.verifiedEdit } : {}),
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
    // An agent that failed has no result to hand on, and `JSON.stringify`
    // returns undefined — not a string — for undefined. Calling .slice on that
    // threw here, inside the context builder, so the exception landed on the
    // *next* agent and removed it from the run; with the entry still on the
    // blackboard, it removed every agent after that one too. The failure is
    // still reported, through the status label, rather than hidden.
    const serialized = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    const valueStr = serialized === undefined ? '(no result)' : serialized.slice(0, 500);
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
