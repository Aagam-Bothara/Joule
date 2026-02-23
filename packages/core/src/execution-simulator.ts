import type { SimulationResult, SimulationIssue } from '@joule/shared';
import type { ToolRegistry } from './tool-registry.js';
import type { ExecutionPlan, PlanStep } from './planner.js';

/** Static risk map: tools that perform irreversible or destructive operations. */
const HIGH_RISK_TOOLS: Record<string, string> = {
  file_write: 'File write may overwrite existing data',
  os_keyboard: 'OS keyboard input may trigger unintended actions',
  os_mouse: 'OS mouse input may click unintended targets',
  browser_evaluate: 'Browser script evaluation may mutate page state',
};

const MEDIUM_RISK_TOOLS: Record<string, string> = {
  browser_click: 'Browser click may trigger navigation or form submission',
  browser_type: 'Browser type may submit forms',
  os_clipboard: 'Clipboard operations may overwrite clipboard contents',
  http_fetch: 'HTTP request may trigger side effects',
};

/**
 * Browser tools that require a prior browser_navigate step to establish page context.
 */
const BROWSER_ACTION_TOOLS = new Set([
  'browser_click', 'browser_type', 'browser_extract',
  'browser_observe', 'browser_wait_and_click', 'browser_evaluate',
  'browser_screenshot',
]);

/**
 * Pre-flight plan validation without side effects.
 * Checks tool availability, schema validity, dependencies, and risk.
 */
export class ExecutionSimulator {
  constructor(private tools: ToolRegistry) {}

  simulate(plan: ExecutionPlan): SimulationResult {
    const issues: SimulationIssue[] = [];

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];

      // 1. Tool availability
      if (!this.tools.has(step.toolName)) {
        issues.push({
          stepIndex: i,
          type: 'missing_tool',
          severity: 'high',
          message: `Tool "${step.toolName}" is not registered`,
        });
        continue; // Skip further checks for missing tools
      }

      // 2. Schema validation
      const tool = this.tools.get(step.toolName);
      if (tool) {
        try {
          const parseResult = tool.inputSchema.safeParse(step.toolArgs);
          if (!parseResult.success) {
            const firstIssue = parseResult.error.issues[0];
            issues.push({
              stepIndex: i,
              type: 'invalid_args',
              severity: 'high',
              message: `Invalid args for "${step.toolName}": ${firstIssue?.message ?? 'schema mismatch'}`,
            });
          }
        } catch {
          // Schema introspection failed — skip validation
        }
      }

      // 3. Dependency analysis
      this.checkDependencies(step, i, plan.steps, issues);

      // 4. Risk assessment
      this.assessRisk(step, i, issues);
    }

    const hasHighSeverity = issues.some(iss => iss.severity === 'high');

    return {
      valid: !hasHighSeverity,
      issues,
      estimatedBudget: {
        modelCalls: 0,
        toolCalls: plan.steps.length,
        estimatedCostUsd: plan.steps.length * 0.001,
      },
    };
  }

  /**
   * Check if a step depends on state established by prior steps.
   * Flags issues when browser action tools appear before any browser_navigate.
   */
  private checkDependencies(
    step: PlanStep,
    index: number,
    allSteps: PlanStep[],
    issues: SimulationIssue[],
  ): void {
    // Browser action tools need a prior browser_navigate
    if (BROWSER_ACTION_TOOLS.has(step.toolName)) {
      const hasNavigate = allSteps
        .slice(0, index)
        .some(s => s.toolName === 'browser_navigate');

      if (!hasNavigate) {
        issues.push({
          stepIndex: index,
          type: 'missing_dependency',
          severity: 'medium',
          message: `"${step.toolName}" at step ${index} has no prior browser_navigate`,
        });
      }
    }

    // Check for forward references in toolArgs (e.g., $output_N patterns)
    const argsStr = JSON.stringify(step.toolArgs);
    const outputRefPattern = /\$output_(\d+)/g;
    let match: RegExpExecArray | null;
    while ((match = outputRefPattern.exec(argsStr)) !== null) {
      const refIndex = parseInt(match[1], 10);
      if (refIndex >= index) {
        issues.push({
          stepIndex: index,
          type: 'missing_dependency',
          severity: 'high',
          message: `Step ${index} references $output_${refIndex} which hasn't executed yet`,
        });
      }
    }
  }

  /**
   * Flag steps that perform destructive or irreversible operations.
   */
  private assessRisk(
    step: PlanStep,
    index: number,
    issues: SimulationIssue[],
  ): void {
    const highRisk = HIGH_RISK_TOOLS[step.toolName];
    if (highRisk) {
      issues.push({
        stepIndex: index,
        type: 'high_risk',
        severity: 'medium',
        message: highRisk,
      });
    }

    const mediumRisk = MEDIUM_RISK_TOOLS[step.toolName];
    if (mediumRisk) {
      issues.push({
        stepIndex: index,
        type: 'high_risk',
        severity: 'low',
        message: mediumRisk,
      });
    }
  }
}
