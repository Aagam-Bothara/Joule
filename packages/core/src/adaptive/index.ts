export { AdaptiveExecutor, type AdaptiveExecutorDeps, type AdaptiveRunResult, type AdaptiveAttach } from './adaptive-executor.js';
export { ConfidenceEngine, type ConfidenceWeights } from './confidence-engine.js';
export { RuleBasedEscalationPolicy, DEFAULT_POLICY_CONFIG, type PolicyInput } from './escalation-policy.js';
export { StepAgent, type AgentAction, type StepAgentTurn, type StepAgentOptions } from './step-agent.js';
export { StepVerifier, matchOutput, PASSTHROUGH_PHASES, type VerificationOutcome, type LlmJudge, type VerificationPhases } from './verifier.js';
export { Consultant } from './consultant.js';
export { buildTrajectoryReport, buildTrajectoryFromTrace, renderTrajectory, type TrajectoryOptions } from './trajectory.js';
export {
  AgentLifecycleTracker,
  LifecycleTransitionError,
  computeLifecycleMetrics,
  renderLifecycleTimeline,
  inToolWait,
  inModelCall,
  type LifecycleTrackerOptions,
  type LifecycleTransitionDetail,
  type LifecycleMetricsOptions,
} from './lifecycle.js';
export {
  createExecutionState,
  currentPlan,
  pushPlan,
  recordStep,
  recordObservation,
  recordFailure,
  recordHypothesis,
  recordDecision,
  maxRepeatedFailure,
  toConsultationRequest,
  toHandoffContext,
  renderConsultation,
  renderHandoff,
  summarizeState,
  normalizeErrorSignature,
} from './execution-state.js';
