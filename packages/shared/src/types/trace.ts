import type { BudgetUsage, BudgetEnvelope } from './budget.js';

export type TraceEventType =
  | 'model_call'
  | 'tool_call'
  | 'routing_decision'
  | 'budget_checkpoint'
  | 'escalation'
  | 'plan_generated'
  | 'replan'
  | 'error'
  | 'info'
  | 'energy_report'
  | 'constitution_violation'
  | 'constitution_output_violation'
  | 'complexity_boosted'
  | 'empty_plan_escalation'
  | 'parse_failure_escalation'
  | 'spec_generated'
  | 'step_verification'
  | 'verification_failed'
  | 'state_transition'
  | 'plan_critique'
  | 'confidence_update'
  | 'goal_checkpoint'
  | 'failure_pattern_match'
  | 'simulation_result'
  | 'simulation_issue'
  | 'decision_point'
  | 'decomposition'
  | 'strategy_selected'
  | 'governance_preflight'
  | 'governance_runtime'
  | 'governance_post_task'
  | 'trust_update'
  | 'policy_evaluation'
  | 'vault_access'
  | 'consensus_vote'
  | 'unified_plan_generated'
  | 'unified_plan_failed'
  | 'fast_path'
  | 'direct_answer'
  | 'pre_screen';

export interface TraceEvent {
  id: string;
  traceId: string;
  parentSpanId?: string;
  type: TraceEventType;
  timestamp: number;
  wallClock: string;
  duration?: number;
  data: Record<string, unknown>;
}

export interface TraceSpan {
  id: string;
  traceId: string;
  name: string;
  startTime: number;
  endTime?: number;
  events: TraceEvent[];
  children: TraceSpan[];
}

export interface ExecutionTrace {
  traceId: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  budget: {
    allocated: BudgetEnvelope;
    used: BudgetUsage;
  };
  spans: TraceSpan[];
}
