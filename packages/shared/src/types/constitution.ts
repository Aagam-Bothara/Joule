// ============================================================================
// Joule Constitution — Immutable Agent Rules
//
// These rules CANNOT be overridden by the agent, by users at runtime, or by
// future configuration changes. They are loaded once at initialization and
// frozen. Think of them as the agent's "firmware-level" ethics.
//
// OpenClaw has nothing like this. Most agent frameworks rely on prompt-level
// instructions that the LLM can be jailbroken out of. Joule enforces rules
// at the code level — tool calls are blocked BEFORE execution, not after.
// ============================================================================

export interface ConstitutionRule {
  id: string;
  name: string;
  description: string;
  severity: 'critical' | 'high' | 'medium';
  category: ConstitutionCategory;
  enforcement: RuleEnforcement;
}

export type ConstitutionCategory =
  | 'safety'        // prevent harm
  | 'privacy'       // protect user data
  | 'integrity'     // prevent deception
  | 'boundaries'    // stay within scope
  | 'resources'     // prevent waste
  | 'transparency'; // be honest about capabilities

export interface RuleEnforcement {
  /** Blocked tool names — these tools can never be called */
  blockedTools?: string[];

  /** Blocked tool argument patterns — regex patterns on serialized args */
  blockedArgPatterns?: Array<{ tool: string; pattern: string; field?: string }>;

  /** Blocked output patterns — if LLM output matches, it's redacted */
  blockedOutputPatterns?: string[];

  /** Required disclaimers — must appear in response for certain topics */
  requiredDisclaimers?: Array<{ trigger: string; disclaimer: string }>;

  /** Max values for specific tool arguments */
  argLimits?: Array<{ tool: string; field: string; max: number }>;

  /** Custom validator function name (for code-level rules) */
  customValidator?: string;
}

export interface ConstitutionViolation {
  ruleId: string;
  ruleName: string;
  severity: ConstitutionRule['severity'];
  category: ConstitutionCategory;
  description: string;
  blockedAction?: string;
  timestamp: string;
}

export interface Constitution {
  version: string;
  name: string;
  description: string;
  rules: ConstitutionRule[];
  /** Once set to true, no new rules can be added and no rules can be removed */
  sealed: boolean;
}
