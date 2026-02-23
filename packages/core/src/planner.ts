import {
  type Task,
  type TaskSpec,
  type PlanScore,
  type SuccessCriterion,
  type StepResult,
  type StepVerification,
  type AutomationStrategy,
  type ModelRequest,
  type ChatMessage,
  ModelTier,
  PlanValidationError,
} from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import type { ModelRouter, RoutingDecision } from './model-router.js';
import type { ToolRegistry } from './tool-registry.js';
import type { BudgetEnvelopeInstance } from './budget-manager.js';
import type { BudgetManager } from './budget-manager.js';
import type { TraceLogger } from './trace-logger.js';
import type { ConstitutionEnforcer } from './constitution.js';

export interface PlannerOptions {
  constitution?: ConstitutionEnforcer;
}

export interface ExecutionPlan {
  taskId: string;
  complexity: number;
  steps: PlanStep[];
  rawResponse?: string;
}

export interface PlanStep {
  index: number;
  description: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  verify?: StepVerification;
  strategy?: AutomationStrategy;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a task complexity classifier. Analyze the given task and respond with ONLY a raw JSON object (no markdown, no code fences, no explanation):
{"complexity": <number between 0.0 and 1.0>, "reason": "<brief reason>"}

Complexity guidelines:
- 0.0-0.3: Simple greetings, pure knowledge questions, or mental math that needs no tools
- 0.3-0.6: Multi-step reasoning tasks that can be answered from knowledge alone
- 0.6-0.8: Tasks requiring one or two tool calls — opening URLs, writing files, fetching data, browsing, sending messages
- 0.8-1.0: Tasks requiring multiple tool steps, deep reasoning, or chained actions

IMPORTANT: Any task that requires a real-world ACTION (opening a browser, navigating a website, writing/creating a file, making an HTTP request, running a shell command, playing media, controlling a device, sending a message) MUST be rated at least 0.7. Only pure knowledge/conversation tasks should be below 0.5.`;

const REPLANNER_SYSTEM_PROMPT_PREFIX = `You are a recovery planner. A previous execution step failed. Given the original task, the error, and completed steps, create a recovery plan.

Rules:
- Do NOT repeat steps that already succeeded
- Create steps to recover from or work around the failure
- Keep recovery plans minimal
- Use ONLY the tools listed below
- Respond with ONLY a raw JSON object (no markdown, no code fences, no explanation):
{"steps": [{"description": "<what this step does>", "toolName": "<tool_name>", "toolArgs": {<arguments>}}]}

Available tools:
`;

const PLANNER_SYSTEM_PROMPT_PREFIX = `You are a smart task planner for an autonomous AI agent. Given a task and available tools, create an execution plan.
Respond with ONLY a raw JSON object (no markdown, no code fences, no explanation):
{"steps": [{"description": "<what this step does>", "toolName": "<tool_name>", "toolArgs": {<arguments>}}]}

Rules:
- ONLY return {"steps": []} if the task is a pure knowledge question, greeting, or conversation that needs NO real-world action
- If the task asks to DO something (open, create, write, navigate, browse, play, fetch, send, run, download, search, control, move, delete, read a file, make a request) you MUST include tool steps — never respond with empty steps for action tasks
- Use ONLY the tools listed below — never invent tools that are not listed
- Each step must use exactly one tool
- Tool arguments must match the tool's expected input exactly — use the argument names shown in each tool's description
- For opening URLs or websites, ALWAYS use browser_navigate — NEVER use shell_exec for URLs
- The OS is ${typeof process !== 'undefined' ? process.platform : 'unknown'} — if you must use shell_exec, use OS-appropriate commands (e.g. "start" on Windows, "open" on macOS, "xdg-open" on Linux)

BROWSER AUTOMATION — Critical Rules:
- You are a FULL autonomous browser agent. You can interact with ANY website — YouTube, Gmail, Twitter, Amazon, LinkedIn, Reddit, Spotify, bank sites, government portals, etc.
- ALWAYS create multi-step plans. Just navigating to a page is NEVER enough — you must also interact (type, click, extract) to complete the user's goal
- Step 1 should ALWAYS be browser_navigate to the target website
- Step 2 onwards: use browser_type, browser_click, browser_extract, browser_evaluate to interact with the page
- Use browser_extract to read page content and find the right elements to interact with
- Use browser_wait_and_click for elements that may take time to appear (popups, ads, suggestions, autocomplete dropdowns, loading spinners)
- Use standard HTML/CSS selectors. Common patterns:
  * Search inputs: input[type="search"], input[name="q"], input[aria-label*="search"], textarea[name="q"]
  * Buttons: button, [role="button"], input[type="submit"]
  * Links: a[href], [role="link"]
  * Text fields: input[type="text"], textarea, div[contenteditable="true"], div[role="textbox"]
  * By text: text=Submit, text=Send, text=Compose
- When you don't know the exact selector, use generic selectors with aria-labels, data attributes, or text content
- After each step, the reactive system will analyze the page and inject additional steps if obstacles are detected (ads, popups, cookie banners, login walls, etc.) — so you don't need to pre-plan for every obstacle

Example — "Play Tere Bina on YouTube":
{"steps": [
  {"description": "Navigate to YouTube", "toolName": "browser_navigate", "toolArgs": {"url": "https://www.youtube.com"}},
  {"description": "Search for the song", "toolName": "browser_type", "toolArgs": {"selector": "input[name='search_query']", "text": "Tere Bina", "submit": true}},
  {"description": "Click the first video result to play it", "toolName": "browser_click", "toolArgs": {"selector": "ytd-video-renderer a#video-title"}},
  {"description": "Skip ad if one appears", "toolName": "browser_wait_and_click", "toolArgs": {"selector": "button.ytp-skip-ad-button, .ytp-ad-skip-button-modern", "timeoutMs": 15000}}
]}

Example — "Send an email via Gmail":
{"steps": [
  {"description": "Navigate to Gmail", "toolName": "browser_navigate", "toolArgs": {"url": "https://mail.google.com"}},
  {"description": "Click Compose button", "toolName": "browser_click", "toolArgs": {"selector": "div[gh='cm'], .T-I.T-I-KE.L3, text=Compose"}},
  {"description": "Type recipient in To field", "toolName": "browser_type", "toolArgs": {"selector": "input[aria-label='To recipients'], input[name='to']", "text": "recipient name"}},
  {"description": "Wait for autocomplete and select", "toolName": "browser_wait_and_click", "toolArgs": {"selector": ".afC, [data-hovercard-id], .vO, .aXjCH", "timeoutMs": 5000}},
  {"description": "Type subject", "toolName": "browser_type", "toolArgs": {"selector": "input[name='subjectbox'], input[aria-label='Subject']", "text": "subject here"}},
  {"description": "Type email body", "toolName": "browser_type", "toolArgs": {"selector": "div[aria-label='Message Body'], div[role='textbox']", "text": "body here"}},
  {"description": "Click Send", "toolName": "browser_click", "toolArgs": {"selector": "div[aria-label='Send'], [data-tooltip*='Send'], text=Send"}}
]}

Example — "Search Google for weather":
{"steps": [
  {"description": "Navigate to Google", "toolName": "browser_navigate", "toolArgs": {"url": "https://www.google.com"}},
  {"description": "Type search query", "toolName": "browser_type", "toolArgs": {"selector": "textarea[name='q'], input[name='q']", "text": "weather", "submit": true}}
]}

OS DESKTOP AUTOMATION — Critical Rules:
- You have full OS-level control: mouse, keyboard, screenshots, window management, clipboard
- These tools work on the PHYSICAL DESKTOP, not inside a browser — for browser content, use browser_* tools
- For mouse operations, use os_screenshot first to identify what is on screen, then os_mouse to interact
- Use os_window to find, focus, or manage application windows
- Use os_keyboard to type text or press hotkeys (e.g., Alt+Tab, Ctrl+C, Win+R)
- Use os_clipboard to read/write clipboard contents

Example — "Take a screenshot of my desktop":
{"steps": [
  {"description": "Capture full screen screenshot", "toolName": "os_screenshot", "toolArgs": {}}
]}

Example — "Open Notepad and type Hello World":
{"steps": [
  {"description": "Open Run dialog", "toolName": "os_keyboard", "toolArgs": {"action": "hotkey", "key": "r", "modifiers": ["win"]}},
  {"description": "Type notepad", "toolName": "os_keyboard", "toolArgs": {"action": "type", "text": "notepad"}},
  {"description": "Press Enter to launch", "toolName": "os_keyboard", "toolArgs": {"action": "press", "key": "enter"}},
  {"description": "Type the message", "toolName": "os_keyboard", "toolArgs": {"action": "type", "text": "Hello World"}}
]}

Example — "Switch to Chrome and copy the URL":
{"steps": [
  {"description": "List all open windows", "toolName": "os_window", "toolArgs": {"action": "list"}},
  {"description": "Focus Chrome window", "toolName": "os_window", "toolArgs": {"action": "focus", "title": "Chrome"}},
  {"description": "Select the address bar", "toolName": "os_keyboard", "toolArgs": {"action": "hotkey", "key": "l", "modifiers": ["ctrl"]}},
  {"description": "Copy URL to clipboard", "toolName": "os_keyboard", "toolArgs": {"action": "hotkey", "key": "c", "modifiers": ["ctrl"]}},
  {"description": "Read the clipboard content", "toolName": "os_clipboard", "toolArgs": {"action": "read"}}
]}

Available tools:
`;

/** Patterns that indicate the task requires real-world tool actions, not just text answers */
const ACTION_PATTERNS: Array<{ pattern: RegExp; minComplexity: number }> = [
  // Browser / navigation
  { pattern: /\b(open|navigate|browse|visit|go\s+to)\b.*(\b(url|website|page|youtube|google|gmail|browser|link|site)\b|https?:\/\/)/i, minComplexity: 0.75 },
  { pattern: /\b(play|watch|stream)\b.*\b(video|song|music|youtube|media)\b/i, minComplexity: 0.75 },
  { pattern: /\b(search|look\s+up)\b.*\b(on|in|using)\b.*\b(youtube|google|web|browser)\b/i, minComplexity: 0.75 },
  { pattern: /\b(click|type|fill|submit|screenshot)\b/i, minComplexity: 0.7 },
  // Email / messaging
  { pattern: /\b(email|gmail)\b.*\b(to|send|write|compose)\b/i, minComplexity: 0.8 },
  { pattern: /\b(send|write|compose)\b.*\b(email|mail)\b/i, minComplexity: 0.8 },
  { pattern: /\b(open)\b.*\b(gmail|email)\b/i, minComplexity: 0.8 },
  // Chat platforms (Discord, Slack, etc.)
  { pattern: /\b(discord|slack|telegram|whatsapp|teams)\b/i, minComplexity: 0.8 },
  { pattern: /\b(message|dm|chat)\b.*\b(on|in|via)\b.*\b(discord|slack|telegram)\b/i, minComplexity: 0.8 },
  // File operations
  { pattern: /\b(create|write|save|make)\b.*\b(file|document|note|text)\b/i, minComplexity: 0.7 },
  { pattern: /\b(read|open|load)\b.*\b(file|document)\b/i, minComplexity: 0.7 },
  { pattern: /\b(download|upload)\b/i, minComplexity: 0.7 },
  // Shell / system
  { pattern: /\b(run|execute|launch|start)\b.*\b(command|script|program|app|application)\b/i, minComplexity: 0.7 },
  { pattern: /\b(install|uninstall|kill|stop|restart)\b/i, minComplexity: 0.7 },
  // Network
  { pattern: /\b(fetch|request|call|post|get)\b.*\b(api|endpoint|url|http|server)\b/i, minComplexity: 0.7 },
  { pattern: /\b(send|forward)\b.*\b(message|email|notification|webhook)\b/i, minComplexity: 0.7 },
  // IoT / devices
  { pattern: /\b(turn\s+on|turn\s+off|toggle|set|control)\b.*\b(light|device|switch|thermostat|sensor)\b/i, minComplexity: 0.7 },
  // OS / Desktop automation
  { pattern: /\b(click|move|drag)\b.*\b(mouse|cursor|pointer|desktop|screen|button)\b/i, minComplexity: 0.75 },
  { pattern: /\b(type|press|hotkey|keyboard)\b.*\b(key|text|shortcut)\b/i, minComplexity: 0.75 },
  { pattern: /\b(screenshot|screen\s*shot|screen\s*grab|capture)\b.*\b(desktop|screen|monitor|display|window)\b/i, minComplexity: 0.7 },
  { pattern: /\b(take\s+a\s+screenshot|screenshot)\b/i, minComplexity: 0.7 },
  { pattern: /\b(minimize|maximize|close|resize|focus|switch)\b.*\b(window|app|application|program)\b/i, minComplexity: 0.7 },
  { pattern: /\b(clipboard|copy|paste)\b.*\b(text|content|data)\b/i, minComplexity: 0.7 },
  { pattern: /\b(alt.tab|ctrl.shift|win.key|windows.key)\b/i, minComplexity: 0.7 },
  { pattern: /\b(list|show)\b.*\b(open\s+)?windows\b/i, minComplexity: 0.7 },
  // Generic action with tool-like objects
  { pattern: /\b(on\s+my\s+desktop|on\s+the\s+desktop|to\s+my\s+desktop)\b/i, minComplexity: 0.7 },
  { pattern: /\buse\s+(?:the\s+)?(?:browser|shell|http|file|tool)\b/i, minComplexity: 0.7 },
];

const SPEC_SYSTEM_PROMPT = `You are a task specification generator. Given a task description, extract a structured specification.
Respond with ONLY a raw JSON object (no markdown, no code fences, no explanation):
{"goal": "<clear one-sentence goal>", "constraints": ["<constraint 1>", ...], "successCriteria": [{"description": "<what must be true>", "type": "<type>", "check": {<details>}}]}

Success criteria types:
- "output_contains": check if the final output contains a specific string → check: {"pattern": "..."}
- "tool_succeeded": check if a specific tool completed without error → check: {"toolName": "..."}
- "page_state": check if a browser page reached a certain state → check: {"urlContains": "...", "titleContains": "..."}
- "file_exists": check if a file was created/modified → check: {"path": "..."}
- "custom": freeform assertion → check: {"assertion": "..."}

Rules:
- Extract 1-3 measurable success criteria from the task
- Keep constraints practical (e.g., "do not delete existing data", "use HTTPS")
- If the task is simple (greeting, question), return a single "custom" criterion
- The goal should be a clear, actionable statement`;

const CRITIQUE_SYSTEM_PROMPT = `You are a plan quality reviewer. Evaluate the execution plan for feasibility, completeness, and correctness.
Respond with ONLY a raw JSON object (no markdown, no code fences, no explanation):
{"overall": <0.0-1.0 overall quality score>, "stepConfidences": [<per-step confidence 0.0-1.0>], "issues": ["<issue description>", ...], "refinedPlan": {"steps": [...]}}

Scoring guidelines:
- 0.9-1.0: Plan is excellent — all steps are correct, complete, and handle edge cases
- 0.7-0.9: Plan is good — minor improvements possible but should work
- 0.5-0.7: Plan has issues — missing steps, wrong selectors, or unclear flow
- 0.0-0.5: Plan is poor — fundamental flaws, missing critical steps, or wrong approach

If overall < 0.5, provide a refinedPlan with corrected steps. Otherwise, refinedPlan is optional.
Each stepConfidence should reflect how likely that individual step is to succeed.
Issues should describe specific problems (e.g., "Step 2 uses wrong selector", "Missing error handling for login wall").`;

export class Planner {
  private constitution?: ConstitutionEnforcer;

  constructor(
    private router: ModelRouter,
    private tools: ToolRegistry,
    private providers: ModelProviderRegistry,
    private budgetManager: BudgetManager,
    private tracer: TraceLogger,
    options?: PlannerOptions,
  ) {
    this.constitution = options?.constitution;
  }

  /**
   * Generate a structured TaskSpec from the task description.
   * Extracts goal, constraints, and 1-3 measurable success criteria.
   * Uses SLM (classify tier) for speed. Gracefully degrades on failure.
   */
  async specifyTask(
    task: Task,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<TaskSpec> {
    const spanId = this.tracer.startSpan(traceId, 'specify-task');

    try {
      const decision = await this.router.route('classify', envelope);

      const response = await this.callModel(decision, {
        system: SPEC_SYSTEM_PROMPT,
        userMessage: task.description,
        history: task.messages?.map(m => ({ role: m.role, content: m.content })),
      });

      this.budgetManager.deductTokens(
        envelope,
        response.tokenUsage.totalTokens,
        response.model,
      );
      this.budgetManager.deductCost(envelope, response.costUsd);

      try {
        const parsed = Planner.extractJson(response.content) as {
          goal?: string;
          constraints?: string[];
          successCriteria?: Array<{
            description?: string;
            type?: SuccessCriterion['type'];
            check?: Record<string, unknown>;
          }>;
        };

        const spec: TaskSpec = {
          goal: parsed.goal || task.description,
          constraints: parsed.constraints ?? [],
          successCriteria: (parsed.successCriteria ?? []).map(c => ({
            description: c.description ?? 'Task completed',
            type: c.type ?? 'tool_succeeded',
            check: c.check ?? {},
          })),
        };

        // Ensure at least one criterion
        if (spec.successCriteria.length === 0) {
          spec.successCriteria.push({
            description: 'Task completed successfully',
            type: 'tool_succeeded',
            check: {},
          });
        }

        this.tracer.logEvent(traceId, 'spec_generated', {
          goal: spec.goal,
          constraintCount: spec.constraints.length,
          criteriaCount: spec.successCriteria.length,
        });

        return spec;
      } catch {
        // Parsing failed — return safe fallback
        return this.fallbackSpec(task.description);
      }
    } catch {
      // Model call failed — return safe fallback
      return this.fallbackSpec(task.description);
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  /**
   * Critique a generated plan for quality, feasibility, and completeness.
   * Uses LLM tier for better reasoning. Returns a PlanScore with per-step
   * confidences and optional refined plan if quality is poor.
   */
  async critiquePlan(
    task: Task,
    plan: ExecutionPlan,
    spec: TaskSpec | undefined,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<PlanScore> {
    const spanId = this.tracer.startSpan(traceId, 'critique-plan');

    try {
      const decision = await this.router.route('plan', envelope, { complexity: 0.8 });

      const planSummary = plan.steps.map((s, i) =>
        `Step ${i + 1}: [${s.toolName}] ${s.description}`
      ).join('\n');

      const specContext = spec
        ? `\nGoal: ${spec.goal}\nSuccess criteria: ${spec.successCriteria.map(c => c.description).join('; ')}`
        : '';

      const userMessage = `Task: ${task.description}${specContext}

Plan to evaluate:
${planSummary}

Available tools: ${this.tools.listNames().join(', ')}`;

      const response = await this.callModel(decision, {
        system: CRITIQUE_SYSTEM_PROMPT,
        userMessage,
      });

      this.budgetManager.deductTokens(
        envelope,
        response.tokenUsage.totalTokens,
        response.model,
      );
      this.budgetManager.deductCost(envelope, response.costUsd);

      try {
        const parsed = Planner.extractJson(response.content) as {
          overall?: number;
          stepConfidences?: number[];
          issues?: string[];
          refinedPlan?: { steps: any[] };
        };

        const score: PlanScore = {
          overall: Math.max(0, Math.min(1, parsed.overall ?? 0.7)),
          stepConfidences: (parsed.stepConfidences ?? plan.steps.map(() => 0.7))
            .map(c => Math.max(0, Math.min(1, c))),
          issues: parsed.issues ?? [],
          refinedPlan: parsed.refinedPlan,
        };

        // Ensure stepConfidences matches plan length
        while (score.stepConfidences.length < plan.steps.length) {
          score.stepConfidences.push(0.7);
        }

        this.tracer.logEvent(traceId, 'plan_critique', {
          overall: score.overall,
          issueCount: score.issues.length,
          hasRefinedPlan: !!score.refinedPlan,
          issues: score.issues,
        });

        return score;
      } catch {
        return this.fallbackScore(plan.steps.length);
      }
    } catch {
      return this.fallbackScore(plan.steps.length);
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  private fallbackScore(stepCount: number): PlanScore {
    return {
      overall: 0.7,
      stepConfidences: Array(stepCount).fill(0.7),
      issues: [],
    };
  }

  private fallbackSpec(description: string): TaskSpec {
    return {
      goal: description,
      constraints: [],
      successCriteria: [{
        description: 'Task completed successfully',
        type: 'tool_succeeded',
        check: {},
      }],
    };
  }

  /**
   * Detect whether a task description implies real-world tool usage.
   * Returns a complexity floor (0 if no action detected, 0.7+ if action detected).
   */
  static detectActionIntent(description: string): number {
    let maxComplexity = 0;
    for (const { pattern, minComplexity } of ACTION_PATTERNS) {
      if (pattern.test(description)) {
        maxComplexity = Math.max(maxComplexity, minComplexity);
      }
    }
    return maxComplexity;
  }

  async classifyComplexity(
    task: Task,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<number> {
    const spanId = this.tracer.startSpan(traceId, 'classify-complexity');

    try {
      // Check for action intent as a complexity floor
      const actionFloor = Planner.detectActionIntent(task.description);

      const decision = await this.router.route('classify', envelope);
      this.tracer.logRoutingDecision(traceId, decision as unknown as Record<string, unknown>);

      const systemPrompt = this.constitution
        ? CLASSIFIER_SYSTEM_PROMPT + this.constitution.buildPromptInjection()
        : CLASSIFIER_SYSTEM_PROMPT;

      const response = await this.callModel(decision, {
        system: systemPrompt,
        userMessage: task.description,
        history: task.messages?.map(m => ({ role: m.role, content: m.content })),
      });

      this.budgetManager.deductTokens(
        envelope,
        response.tokenUsage.totalTokens,
        response.model,
      );
      this.budgetManager.deductCost(envelope, response.costUsd);

      try {
        const parsed = Planner.extractJson(response.content) as { complexity?: number };
        const slmComplexity = Math.max(0, Math.min(1, parsed.complexity ?? 0.5));
        // Take the max of SLM's score and the action-keyword floor
        const complexity = Math.max(slmComplexity, actionFloor);

        if (actionFloor > slmComplexity) {
          this.tracer.logEvent(traceId, 'complexity_boosted', {
            slmScore: slmComplexity,
            actionFloor,
            finalComplexity: complexity,
          });
        }

        return complexity;
      } catch {
        return Math.max(0.5, actionFloor);
      }
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  async plan(
    task: Task,
    complexity: number,
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    spec?: TaskSpec,
    failureContext?: string,
  ): Promise<ExecutionPlan> {
    const spanId = this.tracer.startSpan(traceId, 'generate-plan');

    try {
      const toolDescriptions = this.tools.getToolDescriptions()
        .map(t => `- ${t.name}: ${t.description}`)
        .join('\n');

      let systemPrompt = PLANNER_SYSTEM_PROMPT_PREFIX + toolDescriptions;

      // Inject failure context from learned patterns
      if (failureContext) {
        systemPrompt += `\n\nKNOWN FAILURE PATTERNS — consider these when planning:\n${failureContext}`;
      }

      // Inject success criteria so the model can add verify fields to important steps
      if (spec && spec.successCriteria.length > 0) {
        systemPrompt += `\n\nSUCCESS CRITERIA — the plan must achieve these goals:
${spec.successCriteria.map((c, i) => `${i + 1}. [${c.type}] ${c.description}`).join('\n')}
${spec.constraints.length > 0 ? `\nConstraints: ${spec.constraints.join('; ')}` : ''}

For critical steps, you MAY add a "verify" field: {"type": "output_check"|"dom_check"|"none", "assertion": "<what to check>", "retryOnFail": true, "maxRetries": 2}`;
      }

      if (this.constitution) {
        systemPrompt += this.constitution.buildPromptInjection();
      }

      const decision = await this.router.route('plan', envelope, { complexity });
      this.tracer.logRoutingDecision(traceId, decision as unknown as Record<string, unknown>);

      const response = await this.callModel(decision, {
        system: systemPrompt,
        userMessage: task.description,
        history: task.messages?.map(m => ({ role: m.role, content: m.content })),
      });

      this.budgetManager.deductTokens(
        envelope,
        response.tokenUsage.totalTokens,
        response.model,
      );
      this.budgetManager.deductCost(envelope, response.costUsd);

      const actionFloor = Planner.detectActionIntent(task.description);
      let plan: ExecutionPlan;

      // Try parsing the SLM response; if it fails and we have action intent, escalate
      try {
        plan = this.parsePlan(response.content, task.id, complexity);
      } catch (parseError) {
        // SLM returned unparseable output — escalate to LLM if this is an action task
        if (actionFloor > 0 && this.budgetManager.canAffordEscalation(envelope)) {
          this.tracer.logEvent(traceId, 'parse_failure_escalation', {
            actionFloor,
            parseError: parseError instanceof Error ? parseError.message : String(parseError),
            reason: 'SLM returned unparseable plan — escalating to LLM',
          });

          const llmDecision = await this.router.escalate(envelope, 'SLM plan parse failure');
          this.tracer.logRoutingDecision(traceId, llmDecision as unknown as Record<string, unknown>);

          const llmResponse = await this.callModel(llmDecision, {
            system: systemPrompt,
            userMessage: task.description,
            history: task.messages?.map(m => ({ role: m.role, content: m.content })),
          });

          this.budgetManager.deductTokens(
            envelope,
            llmResponse.tokenUsage.totalTokens,
            llmResponse.model,
          );
          this.budgetManager.deductCost(envelope, llmResponse.costUsd);

          try {
            plan = this.parsePlan(llmResponse.content, task.id, complexity);

            this.tracer.logEvent(traceId, 'plan_generated', {
              steps: plan.steps.length,
              complexity: plan.complexity,
              escalated: true,
              reason: 'parse_failure',
            });

            return plan;
          } catch {
            // LLM also failed — try heuristic fallback
          }
        }

        // Last resort: build a heuristic fallback plan from task description
        const fallback = this.buildFallbackPlan(task.description, task.id);
        if (fallback) {
          this.tracer.logEvent(traceId, 'plan_generated', {
            steps: fallback.steps.length,
            complexity: fallback.complexity,
            fallback: true,
          });
          return fallback;
        }

        throw parseError;
      }

      this.tracer.logEvent(traceId, 'plan_generated', {
        steps: plan.steps.length,
        complexity: plan.complexity,
      });

      // Empty-plan escalation: if SLM returned no steps but the task has action intent,
      // escalate to LLM for a better plan
      if (plan.steps.length === 0 && actionFloor > 0 && this.budgetManager.canAffordEscalation(envelope)) {
        this.tracer.logEvent(traceId, 'empty_plan_escalation', {
          actionFloor,
          reason: 'SLM returned empty plan for action task — escalating to LLM',
        });

        const llmDecision = await this.router.escalate(envelope, 'Empty plan for action task');
        this.tracer.logRoutingDecision(traceId, llmDecision as unknown as Record<string, unknown>);

        const llmResponse = await this.callModel(llmDecision, {
          system: systemPrompt,
          userMessage: task.description,
          history: task.messages?.map(m => ({ role: m.role, content: m.content })),
        });

        this.budgetManager.deductTokens(
          envelope,
          llmResponse.tokenUsage.totalTokens,
          llmResponse.model,
        );
        this.budgetManager.deductCost(envelope, llmResponse.costUsd);

        plan = this.parsePlan(llmResponse.content, task.id, complexity);

        this.tracer.logEvent(traceId, 'plan_generated', {
          steps: plan.steps.length,
          complexity: plan.complexity,
          escalated: true,
        });
      }

      // Plan enrichment: if the plan is a single browser_navigate step but the task
      // clearly requires more interaction (send message, fill form, search, etc.),
      // inject a browser_observe step so the reactive loop can generate the remaining
      // steps based on actual page content. This makes the agent work on ANY website
      // even if the SLM doesn't know the site's specific selectors.
      if (
        plan.steps.length === 1 &&
        plan.steps[0].toolName === 'browser_navigate' &&
        actionFloor >= 0.7 &&
        this.tools.has('browser_observe')
      ) {
        plan.steps.push({
          index: 1,
          description: 'Observe the page to identify interactive elements for the next action',
          toolName: 'browser_observe',
          toolArgs: { purpose: task.description },
        });

        this.tracer.logEvent(traceId, 'info', {
          type: 'plan_enrichment',
          reason: 'Single navigate step enriched with browser_observe for reactive planning',
        });
      }

      return plan;
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  async replan(
    task: Task,
    failedStep: PlanStep,
    failError: string,
    completedSteps: StepResult[],
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<ExecutionPlan> {
    const spanId = this.tracer.startSpan(traceId, 'replan');

    try {
      const toolDescriptions = this.tools.getToolDescriptions()
        .map(t => `- ${t.name}: ${t.description}`)
        .join('\n');

      let systemPrompt = REPLANNER_SYSTEM_PROMPT_PREFIX + toolDescriptions;
      if (this.constitution) {
        systemPrompt += this.constitution.buildPromptInjection();
      }

      const completedSummary = completedSteps.length > 0
        ? completedSteps.map((r, i) =>
            `Step ${i + 1} (${r.toolName}): ${r.success ? 'SUCCESS' : 'FAILED'} - ${r.success ? JSON.stringify(r.output) : r.error}`
          ).join('\n')
        : 'No steps completed yet.';

      const userMessage = `Original task: ${task.description}

Failed step ${failedStep.index + 1}: ${failedStep.description}
Tool: ${failedStep.toolName}
Error: ${failError}

Completed steps:
${completedSummary}

Create a recovery plan to complete the original task.`;

      // Escalate to LLM for recovery planning
      const decision = await this.router.escalate(envelope, `Step ${failedStep.index} failed: ${failError}`);
      this.tracer.logRoutingDecision(traceId, decision as unknown as Record<string, unknown>);

      const response = await this.callModel(decision, {
        system: systemPrompt,
        userMessage,
      });

      this.budgetManager.deductTokens(
        envelope,
        response.tokenUsage.totalTokens,
        response.model,
      );
      this.budgetManager.deductCost(envelope, response.costUsd);

      const plan = this.parsePlan(response.content, task.id, 0.9);

      this.tracer.logEvent(traceId, 'replan', {
        failedStep: failedStep.index,
        failError,
        recoverySteps: plan.steps.length,
      });

      return plan;
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  /**
   * Reactive planning: given the current state after a step execution,
   * decide whether additional steps are needed (e.g., dismiss popup, skip ad,
   * accept cookies, handle login wall, etc.).
   *
   * Returns additional steps to inject, or an empty array if the plan should
   * proceed as-is.
   */
  async planReactiveSteps(
    task: Task,
    lastStepResult: StepResult,
    completedSteps: StepResult[],
    remainingSteps: PlanStep[],
    envelope: BudgetEnvelopeInstance,
    traceId: string,
  ): Promise<PlanStep[]> {
    // Only react to browser tool outputs that include page content
    if (!lastStepResult.success) return [];
    const output = lastStepResult.output as Record<string, unknown> | undefined;
    if (!output) return [];

    // Trigger for browser and OS automation tools
    const isReactiveStep = lastStepResult.toolName.startsWith('browser_') || lastStepResult.toolName.startsWith('os_');
    if (!isReactiveStep) return [];

    // Don't react if budget is tight
    if (!this.budgetManager.canAffordEscalation(envelope)) return [];

    const spanId = this.tracer.startSpan(traceId, 'reactive-plan');

    try {
      const toolDescriptions = this.tools.getToolDescriptions()
        .map(t => `- ${t.name}: ${t.description}`)
        .join('\n');

      const pageContext = output.title ? `Page title: ${output.title}` : '';
      const pageContent = typeof output.content === 'string'
        ? output.content.slice(0, 2000)
        : '';

      // If the last step was browser_observe, include the interactive elements
      // so the reactive planner can use real CSS selectors
      let observeContext = '';
      if (lastStepResult.toolName === 'browser_observe' && output.interactiveElements) {
        const elements = output.interactiveElements as Array<{ index: number; tag: string; text: string; selector: string; ariaLabel?: string; placeholder?: string }>;
        if (elements.length > 0) {
          observeContext = `\nInteractive elements found on the page:\n${elements.slice(0, 50).map(e =>
            `  [${e.index}] <${e.tag}> selector="${e.selector}" text="${e.text}"${e.ariaLabel ? ` aria-label="${e.ariaLabel}"` : ''}${e.placeholder ? ` placeholder="${e.placeholder}"` : ''}`
          ).join('\n')}`;
        } else {
          observeContext = '\nNo interactive elements found — the page may still be loading or is a heavy SPA.';
        }
        const forms = output.forms as Array<{ action: string; method: string; inputs: string[] }> | undefined;
        if (forms && forms.length > 0) {
          observeContext += `\nForms: ${forms.map(f => `${f.method} ${f.action} — fields: ${f.inputs.join(', ')}`).join('; ')}`;
        }
      }

      const remainingSummary = remainingSteps.length > 0
        ? `Remaining planned steps:\n${remainingSteps.map((s, i) => `  ${i + 1}. ${s.description} (${s.toolName})`).join('\n')}`
        : 'No more planned steps.';

      const systemPrompt = `You are a reactive agent planner for an autonomous browser agent. After a browser step was executed, you analyze the current page state and decide what to do next.

You have TWO responsibilities:
1. OBSTACLE HANDLING: Detect and handle obstacles (ads, popups, cookie banners, login walls)
2. NEXT ACTION PLANNING: If the last step was browser_observe, you now have the page's interactive elements with their CSS selectors. Use this information to plan the NEXT steps needed to complete the user's task. Pick the correct elements from the list and create steps using their exact selectors.

Respond with ONLY a raw JSON object (no markdown, no code fences):
{"additionalSteps": [{"description": "...", "toolName": "...", "toolArgs": {...}}], "reason": "..."}

Return {"additionalSteps": [], "reason": "no action needed"} ONLY if the task is already complete.

You are a SMART agent. Analyze the page content and detect:
1. Ads/overlays: Skip buttons, ad overlays, video ads → use browser_wait_and_click
2. Cookie/consent banners: "Accept", "Allow", "I agree", "Got it" → click to dismiss
3. Login/signup popups: close buttons, "No thanks", "Maybe later", "X" → dismiss
4. Age verification: "I am over 18", "Confirm age" → click to proceed
5. Notification/permission prompts: "Block", "Not now", "Dismiss" → dismiss
6. CAPTCHA challenges → use captcha tools if available
7. Unexpected redirects: login pages when user should be logged in, error pages → adapt
8. Page not fully loaded: if content seems empty, add a wait step
9. Form validation errors: re-fill or correct fields

If the page shows a login form and the user's task requires being logged in, add an observation step (browser_observe) to understand the page better before proceeding.

IMPORTANT: Only add steps for obstacles you can CLEARLY see in the page content. Don't add unnecessary steps. Be efficient.

Available tools:
${toolDescriptions}`;

      const userMessage = `Original task: ${task.description}

Last step executed: ${lastStepResult.toolName} — ${lastStepResult.success ? 'SUCCESS' : 'FAILED'}
${pageContext}
Page content (truncated): ${pageContent || '(not available)'}
${observeContext}

${remainingSummary}

${observeContext ? 'Using the interactive elements above, plan the next steps to complete the task. Use the exact selectors from the element list.' : 'Analyze: are there any obstacles on the current page that need handling before continuing?'}`;

      // Use higher complexity for observe results (need smarter model to pick selectors)
      const reactiveComplexity = lastStepResult.toolName === 'browser_observe' ? 0.8 : 0.5;
      const decision = await this.router.route('plan', envelope, { complexity: reactiveComplexity });
      const response = await this.callModel(decision, {
        system: systemPrompt,
        userMessage,
      });

      this.budgetManager.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budgetManager.deductCost(envelope, response.costUsd);

      try {
        const parsed = Planner.extractJson(response.content) as {
          additionalSteps?: Array<{ description?: string; toolName?: string; toolArgs?: Record<string, unknown> }>;
          reason?: string;
        };

        const additionalSteps = (parsed.additionalSteps ?? [])
          .filter(s => s.toolName && this.tools.has(s.toolName))
          .map((s, i) => ({
            index: i,
            description: s.description ?? '',
            toolName: s.toolName!,
            toolArgs: s.toolArgs ?? {},
          }));

        if (additionalSteps.length > 0) {
          this.tracer.logEvent(traceId, 'info', {
            type: 'reactive_steps_injected',
            count: additionalSteps.length,
            reason: parsed.reason ?? 'obstacle detected',
            steps: additionalSteps.map(s => s.description),
          });
        }

        return additionalSteps;
      } catch {
        return [];
      }
    } finally {
      this.tracer.endSpan(traceId, spanId);
    }
  }

  validatePlan(plan: ExecutionPlan): void {
    // Empty plans are valid — means direct answer, no tools needed
    for (const step of plan.steps) {
      if (!this.tools.has(step.toolName)) {
        throw new PlanValidationError(
          `Step ${step.index}: tool "${step.toolName}" not found. Available: ${this.tools.listNames().join(', ')}`,
        );
      }
    }
  }

  /**
   * Extract a JSON object from a model response that may be wrapped in
   * markdown code fences, prefixed with explanatory text, or otherwise
   * decorated.  Returns the parsed object or throws.
   */
  private static extractJson(raw: string): unknown {
    // 1. Strip markdown code fences: ```json ... ``` or ``` ... ```
    let cleaned = raw.replace(/```(?:json)?\s*\n?/gi, '').replace(/```/g, '').trim();

    // 2. Try direct parse first (fastest path)
    try { return JSON.parse(cleaned); } catch { /* fall through */ }

    // 3. Regex out the first { ... } block
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in response');
    }
    return JSON.parse(jsonMatch[0]);
  }

  /**
   * Build a heuristic fallback plan when all models fail to produce valid JSON.
   * Extracts URLs and intent from the task description and maps them to tools.
   * Generates multi-step plans for browser automation (navigate + interact).
   */
  private buildFallbackPlan(description: string, taskId: string): ExecutionPlan | null {
    const steps: PlanStep[] = [];
    const hasBrowserNav = this.tools.has('browser_navigate');
    const hasBrowserType = this.tools.has('browser_type');
    const hasBrowserClick = this.tools.has('browser_click');

    // Extract URLs from description
    const urlMatch = description.match(/https?:\/\/[^\s"'<>]+/i);

    // Detect intent
    const playIntent = /\b(play|watch|stream)\b/i.test(description);
    const youtubeIntent = /\b(youtube|video|song|music)\b/i.test(description);
    const searchIntent = /\b(search|look\s*up|find|google)\b/i.test(description);
    const emailIntent = /\b(email|gmail|compose\s+(?:an?\s+)?email|send\s+(?:an?\s+)?(?:email|mail))\b/i.test(description) && !/\b(discord|slack|telegram|whatsapp|teams)\b/i.test(description);
    const browserIntent = /\b(open|navigate|browse|visit|go\s+to)\b/i.test(description) || playIntent || youtubeIntent || searchIntent || emailIntent;

    // Extract the "subject" — what the user wants to find/play
    const extractSubject = (): string => {
      return description
        .replace(/\b(open|navigate|browse|visit|go\s+to|play|watch|stream|search|look\s+up|find|youtube|google|in\s+the\s+browser|on\s+youtube|on\s+google|a\s+|the\s+|for\s+me|for\s+|me\s+|and\s+|song\s+called|song\s+named|video\s+called|video\s+named)\b/gi, '')
        .replace(/[^\w\s'-]/g, '')
        .trim();
    };

    // Email / Gmail flow: navigate → compose → fill To → select suggestion → fill subject → fill body → send
    if (emailIntent && hasBrowserNav && hasBrowserType && hasBrowserClick) {
      // Extract recipient name
      const recipientMatch = description.match(/(?:to|email|mail)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
      const recipient = recipientMatch ? recipientMatch[1].trim() : '';

      // Extract subject
      const subjectMatch = description.match(/subject\s+(?:is\s+|line\s+)?['"]?([^'",.]+?)['"]?(?:\s+and\b|\s+with\b|$)/i);
      const subject = subjectMatch ? subjectMatch[1].trim() : 'Hello';

      // Extract body content
      const bodyMatch = description.match(/(?:content|body|write|message)\s+(?:is\s+|with\s+)?['"]?(.+?)['"]?$/i);
      const body = bodyMatch ? bodyMatch[1].trim() : 'This is an automated message sent via Joule.';

      steps.push(
        { index: 0, description: 'Navigate to Gmail', toolName: 'browser_navigate', toolArgs: { url: 'https://mail.google.com' } },
        { index: 1, description: 'Click Compose button', toolName: 'browser_click', toolArgs: { selector: '.T-I.T-I-KE.L3' } },
      );

      if (recipient) {
        steps.push(
          { index: 2, description: `Type recipient "${recipient}" in To field`, toolName: 'browser_type', toolArgs: { selector: "input[aria-label='To recipients']", text: recipient } },
        );
        if (this.tools.has('browser_wait_and_click')) {
          steps.push(
            { index: 3, description: 'Click autocomplete suggestion for recipient', toolName: 'browser_wait_and_click', toolArgs: { selector: '.afC, .aXjCH, [data-hovercard-id], .vO', timeoutMs: 5000 } },
          );
        }
      }

      steps.push(
        { index: steps.length, description: 'Type subject line', toolName: 'browser_type', toolArgs: { selector: "input[name='subjectbox']", text: subject } },
        { index: steps.length + 1, description: 'Type email body', toolName: 'browser_type', toolArgs: { selector: "div[aria-label='Message Body'], div[role='textbox']", text: body } },
        { index: steps.length + 2, description: 'Click Send', toolName: 'browser_click', toolArgs: { selector: "div[aria-label='Send'][role='button'], .T-I.J-J5-Ji[data-tooltip*='Send']" } },
      );

      return { taskId, complexity: 0.85, steps, rawResponse: '[fallback-plan-email]' };
    }

    if (urlMatch && hasBrowserNav) {
      // Direct URL — navigate to it
      steps.push({
        index: 0,
        description: `Navigate to ${urlMatch[0]}`,
        toolName: 'browser_navigate',
        toolArgs: { url: urlMatch[0] },
      });
    } else if ((youtubeIntent || playIntent) && hasBrowserNav) {
      // YouTube play flow: navigate → search → click → skip ad
      const subject = extractSubject();
      steps.push({
        index: 0,
        description: 'Navigate to YouTube',
        toolName: 'browser_navigate',
        toolArgs: { url: 'https://www.youtube.com' },
      });

      if (hasBrowserType && subject) {
        steps.push({
          index: 1,
          description: `Search for "${subject}"`,
          toolName: 'browser_type',
          toolArgs: { selector: 'input[name="search_query"]', text: subject, submit: true },
        });
      }

      if (hasBrowserClick) {
        steps.push({
          index: steps.length,
          description: 'Click the first video result to play it',
          toolName: 'browser_click',
          toolArgs: { selector: 'ytd-video-renderer a#video-title' },
        });
      }

      // Ad skip step — wait for skip button and click if it appears
      if (this.tools.has('browser_wait_and_click')) {
        steps.push({
          index: steps.length,
          description: 'Skip YouTube ad if one appears',
          toolName: 'browser_wait_and_click',
          toolArgs: {
            selector: 'button.ytp-skip-ad-button, .ytp-ad-skip-button-modern',
            timeoutMs: 15000,
          },
        });
      }
    } else if (searchIntent && hasBrowserNav) {
      // Google search flow: navigate → search
      const subject = extractSubject();
      steps.push({
        index: 0,
        description: 'Navigate to Google',
        toolName: 'browser_navigate',
        toolArgs: { url: 'https://www.google.com' },
      });

      if (hasBrowserType && subject) {
        steps.push({
          index: 1,
          description: `Search for "${subject}"`,
          toolName: 'browser_type',
          toolArgs: { selector: 'textarea[name="q"]', text: subject, submit: true },
        });
      }
    } else if (browserIntent && hasBrowserNav) {
      // Generic browser open — extract best URL guess
      const subject = extractSubject();
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(subject)}`;
      steps.push({
        index: 0,
        description: `Search the web for "${subject}"`,
        toolName: 'browser_navigate',
        toolArgs: { url: searchUrl },
      });
    }

    if (steps.length === 0) return null;

    return { taskId, complexity: 0.75, steps, rawResponse: '[fallback-plan]' };
  }

  private parsePlan(content: string, taskId: string, complexity: number): ExecutionPlan {
    try {
      const parsed = Planner.extractJson(content) as { steps?: Array<{ description?: string; toolName?: string; toolArgs?: Record<string, unknown>; verify?: StepVerification }> };
      const steps: PlanStep[] = (parsed.steps ?? []).map(
        (s: { description?: string; toolName?: string; toolArgs?: Record<string, unknown>; verify?: StepVerification }, i: number) => ({
          index: i,
          description: s.description ?? '',
          toolName: s.toolName ?? '',
          toolArgs: s.toolArgs ?? {},
          ...(s.verify ? { verify: s.verify } : {}),
        }),
      );

      return {
        taskId,
        complexity,
        steps,
        rawResponse: content,
      };
    } catch (error) {
      throw new PlanValidationError(
        `Failed to parse plan from model response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async callModel(
    decision: RoutingDecision,
    opts: { system: string; userMessage: string; history?: Array<{ role: string; content: string }> },
  ) {
    const provider = this.providers.get(decision.provider);
    if (!provider) {
      throw new Error(`Provider not found: ${decision.provider}`);
    }

    // Build messages: include history for context if provided
    const messages: ChatMessage[] = [];
    if (opts.history && opts.history.length > 0) {
      messages.push(...opts.history.map(m => ({ role: m.role as ChatMessage['role'], content: m.content })));
    }
    messages.push({ role: 'user', content: opts.userMessage });

    const request: ModelRequest = {
      model: decision.model,
      provider: decision.provider,
      tier: decision.tier as ModelTier,
      system: opts.system,
      messages,
      responseFormat: 'json',
      temperature: 0.1,
    };

    return provider.chat(request);
  }

  // ─── Hybrid Automation Strategy ───

  /**
   * Select the optimal automation approach for a plan step.
   * Returns a strategy with primary approach and fallback chain.
   */
  selectAutomationStrategy(task: Task, step: PlanStep): AutomationStrategy {
    const toolName = step.toolName;

    // API preferred: if task mentions API/REST/fetch or step uses http_fetch
    if (toolName === 'http_fetch' || /\b(api|rest|endpoint|fetch)\b/i.test(task.description)) {
      return { primary: 'api', fallbackChain: ['dom', 'vision'], reason: 'API access detected' };
    }

    // Vision preferred: if task mentions visual/screenshot/appearance
    if (/\b(screenshot|visual|image|look\s+at|appearance|layout)\b/i.test(task.description)) {
      return { primary: 'vision', fallbackChain: ['dom', 'api'], reason: 'Visual task detected' };
    }

    // DOM default: standard browser automation
    if (toolName.startsWith('browser_')) {
      return { primary: 'dom', fallbackChain: ['vision', 'api'], reason: 'Standard browser automation' };
    }

    // Non-browser tools: no strategy needed
    return { primary: 'dom', fallbackChain: [], reason: 'Default approach' };
  }

  /**
   * Annotate plan steps with automation strategies for browser tasks.
   */
  annotatePlanWithStrategies(task: Task, plan: ExecutionPlan): void {
    for (const step of plan.steps) {
      if (step.toolName.startsWith('browser_') || step.toolName === 'http_fetch') {
        step.strategy = this.selectAutomationStrategy(task, step);
      }
    }
  }
}
