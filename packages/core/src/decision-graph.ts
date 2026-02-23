import {
  type DecisionNode,
  type DecisionEdge,
  type DecisionGraph,
  type AgentState,
  type ExecutionTrace,
  type TraceSpan,
  type TraceEvent,
  generateId,
} from '@joule/shared';

/** Trace event types that represent decision points. */
const DECISION_EVENT_TYPES = new Set([
  'state_transition',
  'routing_decision',
  'plan_critique',
  'escalation',
  'replan',
  'simulation_result',
  'goal_checkpoint',
  'strategy_selected',
]);

/**
 * Builds a structured decision graph from an ExecutionTrace.
 * Extracts decision points, creates causal edges, and identifies the critical path.
 */
export class DecisionGraphBuilder {
  buildFromTrace(taskId: string, trace: ExecutionTrace): DecisionGraph {
    const nodes: DecisionNode[] = [];
    const edges: DecisionEdge[] = [];

    // Walk all spans and events, extract decision points
    this.extractDecisions(trace.spans, nodes, edges);

    // Build causal edges between sequential decisions
    this.buildCausalEdges(nodes, edges);

    // Find critical path (longest causal chain)
    const criticalPath = this.findCriticalPath(nodes, edges);

    return { taskId, nodes, edges, criticalPath };
  }

  /**
   * Recursively walk spans and extract decision-relevant events as nodes.
   */
  private extractDecisions(
    spans: TraceSpan[],
    nodes: DecisionNode[],
    edges: DecisionEdge[],
  ): void {
    const escalationEventIds: string[] = [];

    this.walkSpans(spans, nodes, escalationEventIds);

    // Link escalation events to recovery nodes in a second pass
    // (recovery nodes may appear after the escalation event)
    for (const escId of escalationEventIds) {
      this.linkEscalation(escId, nodes, edges);
    }
  }

  private walkSpans(
    spans: TraceSpan[],
    nodes: DecisionNode[],
    escalationEventIds: string[],
  ): void {
    for (const span of spans) {
      for (const event of span.events) {
        if (!DECISION_EVENT_TYPES.has(event.type)) continue;
        const node = this.eventToNode(event);
        if (node) {
          nodes.push(node);
        }

        if (event.type === 'escalation') {
          escalationEventIds.push(event.id);
        }
      }

      this.walkSpans(span.children, nodes, escalationEventIds);
    }
  }

  /**
   * Convert a trace event into a decision node.
   */
  private eventToNode(event: TraceEvent): DecisionNode | null {
    const base = {
      id: event.id,
      timestamp: event.timestamp,
      children: [],
      alternatives: [],
    };

    switch (event.type) {
      case 'state_transition':
        return {
          ...base,
          phase: (event.data.to as AgentState) ?? 'idle',
          decision: `Transitioned to ${event.data.to}`,
          rationale: `From ${event.data.from} to ${event.data.to}`,
          confidence: 1.0,
        };

      case 'routing_decision':
        return {
          ...base,
          phase: 'act',
          decision: `Routed to ${event.data.provider}/${event.data.model} (${event.data.tier})`,
          rationale: (event.data.reason as string) ?? 'Model routing decision',
          confidence: 1.0 - ((event.data.estimatedCost as number) ?? 0),
          alternatives: event.data.tier === 'LLM' ? ['SLM'] : ['LLM'],
        };

      case 'plan_critique':
        return {
          ...base,
          phase: 'critique',
          decision: `Plan scored ${event.data.overall}/1.0`,
          rationale: (event.data.issueCount as number) > 0
            ? `${event.data.issueCount} issues identified`
            : 'Plan approved with no issues',
          confidence: (event.data.overall as number) ?? 0.7,
          alternatives: (event.data.issueCount as number) > 0 ? ['Refine plan'] : [],
        };

      case 'escalation':
        return {
          ...base,
          phase: 'recover',
          decision: `Escalated: ${event.data.reason}`,
          rationale: `Step ${event.data.step} failed, replan depth ${event.data.replanDepth}`,
          confidence: 0.5,
          alternatives: ['Skip step', 'Abort task'],
        };

      case 'replan':
        return {
          ...base,
          phase: 'recover',
          decision: 'Replanned execution',
          rationale: (event.data.reason as string) ?? 'Recovery replan',
          confidence: 0.6,
        };

      case 'simulation_result':
        return {
          ...base,
          phase: 'simulate',
          decision: event.data.valid ? 'Simulation passed' : 'Simulation found issues',
          rationale: `${event.data.issueCount} issues, estimated cost $${event.data.estimatedCostUsd}`,
          confidence: event.data.valid ? 0.9 : 0.4,
          alternatives: event.data.valid ? [] : ['Replan', 'Proceed with caution'],
        };

      case 'goal_checkpoint':
        return {
          ...base,
          phase: 'checkpoint',
          decision: event.data.onTrack ? 'On track' : 'Goal drift detected',
          rationale: Array.isArray(event.data.drift) && event.data.drift.length > 0
            ? `Drift: ${(event.data.drift as string[]).join('; ')}`
            : 'Execution aligned with goal',
          confidence: event.data.onTrack ? 0.9 : 0.3,
          alternatives: event.data.onTrack ? [] : ['Replan', 'Continue anyway'],
        };

      case 'strategy_selected':
        return {
          ...base,
          phase: 'act',
          decision: `Strategy fallback: ${event.data.original} → ${event.data.fallback}`,
          rationale: (event.data.reason as string) ?? 'Strategy change',
          confidence: 0.6,
          alternatives: [`Keep ${event.data.original}`, 'Abort step'],
        };

      default:
        return null;
    }
  }

  /**
   * Link an escalation node to the nearest subsequent recovery node.
   */
  private linkEscalation(
    escalationId: string,
    nodes: DecisionNode[],
    edges: DecisionEdge[],
  ): void {
    const escIdx = nodes.findIndex(n => n.id === escalationId);
    if (escIdx < 0) return;

    for (let i = escIdx + 1; i < nodes.length; i++) {
      if (nodes[i].phase === 'recover') {
        edges.push({
          from: escalationId,
          to: nodes[i].id,
          type: 'triggered',
          label: 'recovery',
        });
        break;
      }
    }
  }

  /**
   * Build causal edges between sequential decision nodes.
   * Adjacent nodes in time get 'led_to' edges.
   */
  private buildCausalEdges(nodes: DecisionNode[], edges: DecisionEdge[]): void {
    // Sort by timestamp
    const sorted = [...nodes].sort((a, b) => a.timestamp - b.timestamp);

    for (let i = 0; i < sorted.length - 1; i++) {
      const current = sorted[i];
      const next = sorted[i + 1];

      // Don't duplicate edges that already exist
      const alreadyLinked = edges.some(
        e => e.from === current.id && e.to === next.id,
      );

      if (!alreadyLinked) {
        edges.push({
          from: current.id,
          to: next.id,
          type: 'led_to',
        });
      }

      // Register children
      if (!current.children.includes(next.id)) {
        current.children.push(next.id);
      }
    }
  }

  /**
   * Find the critical path: longest chain of causal/triggered edges.
   */
  findCriticalPath(nodes: DecisionNode[], edges: DecisionEdge[]): string[] {
    if (nodes.length === 0) return [];

    // Build adjacency list from causal edges
    const adj = new Map<string, string[]>();
    for (const node of nodes) {
      adj.set(node.id, []);
    }
    for (const edge of edges) {
      if (edge.type === 'caused' || edge.type === 'led_to' || edge.type === 'triggered') {
        adj.get(edge.from)?.push(edge.to);
      }
    }

    // Find longest path using DFS with memoization
    const memo = new Map<string, string[]>();

    const dfs = (nodeId: string, visited: Set<string>): string[] => {
      if (memo.has(nodeId) && !visited.has(nodeId)) return memo.get(nodeId)!;
      if (visited.has(nodeId)) return [nodeId]; // Cycle protection

      visited.add(nodeId);
      const neighbors = adj.get(nodeId) ?? [];
      let longestSubPath: string[] = [];

      for (const next of neighbors) {
        const subPath = dfs(next, new Set(visited));
        if (subPath.length > longestSubPath.length) {
          longestSubPath = subPath;
        }
      }

      const result = [nodeId, ...longestSubPath];
      memo.set(nodeId, result);
      return result;
    };

    // Try starting from each node, return the longest path
    let longestPath: string[] = [];
    const sorted = [...nodes].sort((a, b) => a.timestamp - b.timestamp);

    for (const node of sorted) {
      const path = dfs(node.id, new Set());
      if (path.length > longestPath.length) {
        longestPath = path;
      }
    }

    return longestPath;
  }
}
