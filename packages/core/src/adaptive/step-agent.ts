/**
 * StepAgent — one model-driven loop, tier as a parameter.
 *
 * Given the execution state and a conversation window, the agent proposes
 * exactly one structured action per turn. The same class drives the SLM and,
 * after a handoff, the LLM — which is what lets the LLM continue from the
 * current state instead of restarting.
 */

import {
  ModelTier,
  type ChatMessage,
  type ExecutionState,
  type ModelRequest,
  type ModelResponse,
  type StepVerification,
  type Task,
} from '@joule/shared';
import type { ModelProviderRegistry } from '@joule/models';
import type { ModelRouter, RoutingDecision } from '../model-router.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { BudgetEnvelopeInstance } from '../budget-manager.js';
import type { ConstitutionEnforcer } from '../constitution.js';

export type AgentAction =
  | {
      type: 'tool_call';
      toolName: string;
      toolArgs: Record<string, unknown>;
      description: string;
      thought?: string;
      verify?: StepVerification;
      hypothesis?: string;
      plan?: string[];
    }
  | { type: 'final_answer'; answer: string; plan?: string[] }
  | { type: 'ask_consult'; question: string; hypotheses: string[] }
  | { type: 'give_up'; reason: string }
  | { type: 'malformed'; raw: string };

export interface StepAgentTurn {
  action: AgentAction;
  response: ModelResponse;
  request: ModelRequest;
  decision: RoutingDecision;
}

export interface StepAgentOptions {
  constitution?: ConstitutionEnforcer;
  agentRole?: string;
  agentInstructions?: string;
  /** Keep at most this many messages (first message is always kept). Default 24 */
  maxHistory?: number;
  /** Use only task-relevant tool descriptions when more than this many tools are registered. Default 12 */
  relevantToolsAbove?: number;
  /** Output token cap per agent turn. Default 4096 */
  maxTokens?: number;
}

const MAX_TOOL_ARG_CHARS = 50_000;

export class StepAgent {
  private readonly maxHistory: number;
  private readonly relevantToolsAbove: number;

  constructor(
    private router: ModelRouter,
    private providers: ModelProviderRegistry,
    private tools: ToolRegistry,
    private options: StepAgentOptions = {},
  ) {
    this.maxHistory = options.maxHistory ?? 24;
    this.relevantToolsAbove = options.relevantToolsAbove ?? 12;
  }

  /** Ask the model at `tier` for the next action. */
  async next(
    task: Task,
    state: ExecutionState,
    envelope: BudgetEnvelopeInstance,
    tier: ModelTier,
    history: ChatMessage[],
  ): Promise<StepAgentTurn> {
    const decision = await this.router.route('execute', envelope, { forceTier: tier });
    const provider = this.providers.get(decision.provider);
    if (!provider) throw new Error(`Provider not available: ${decision.provider}`);

    const request: ModelRequest = {
      model: decision.model,
      provider: decision.provider,
      tier: decision.tier,
      system: this.buildSystemPrompt(task, state),
      messages: this.window(history),
      temperature: 0.2,
      responseFormat: 'json',
      // Final answers are JSON-wrapped prose; the providers' 1024 default truncates them.
      maxTokens: this.options.maxTokens ?? 4096,
    };

    const response = await provider.chat(request);
    const action = StepAgent.parseAction(response.content);
    return { action, response, request, decision };
  }

  buildSystemPrompt(task: Task, state: ExecutionState): string {
    const toolList = this.toolDescriptions(task);
    let prompt = `You are Joule's step agent. You complete the task one step at a time using tools. After every step you receive the observation. Keep a short plan and update it as you learn.

Respond with ONLY a raw JSON object (no markdown, no code fences, no text outside the JSON) in exactly one of these forms:

1. Take a step:
{"action":"tool_call","thought":"<one sentence: why this step>","toolName":"<tool>","toolArgs":{...},"plan":["<remaining steps, short>"],"verify":{"type":"command_exit","command":"<check command>"},"hypothesis":"<optional: what you currently believe>"}
   - "plan" is required on your first step and whenever it changes; omit otherwise.
   - "verify" is optional. Types: "command_exit" (run "command", pass = exit code 0), "test_result" (like command_exit plus "assertion" regex on output), "output_check" ("assertion" regex over the tool output).
   - Prefer verifying your work with a real check (tests, build, reading the file back) before finishing.

2. Finish:
{"action":"final_answer","answer":"<complete answer for the user>"}

3. Ask for help when you are stuck on ONE specific decision but understand the rest of the task:
{"action":"ask_consult","question":"<one focused question with the concrete options>","hypotheses":["<what you think>"]}

4. Give up only when the task is impossible with the available tools:
{"action":"give_up","reason":"<why>"}

Rules:
- If the task is a question you can answer from your own knowledge (explain, compare, list, design, plan), answer immediately with final_answer. Do not fetch, write files, or run commands unless the task asks for an action or needs facts you do not have.
- Only use tools on things that exist in this environment. A task that describes a scenario (a service, a bug, an incident) without naming real files, paths or URLs has nothing to inspect: reason it through and answer with final_answer.
- Ask for a consultation only after you have evidence (a result or a failure) and are stuck on one specific decision — never as your first move.
- Use ONLY the tools listed below. Arguments must match the tool's input exactly.
- One tool call per turn.
- Never repeat an identical call that already failed; change the approach instead.
- Do not invent results; rely on observations.`;

    if (this.options.agentRole) {
      prompt = `[AGENT ROLE: ${this.options.agentRole}]\n[AGENT INSTRUCTIONS: ${this.options.agentInstructions ?? ''}]\n\n${prompt}`;
    }

    if (state.constraints.length > 0) {
      prompt += `\n\nConstraints:\n${state.constraints.map(c => `- ${c}`).join('\n')}`;
    }

    prompt += toolList.length > 0
      ? `\n\nAvailable tools:\n${toolList.map(t => `- ${t.name}: ${t.description}`).join('\n')}`
      : '\n\nNo tools are available. Answer directly with {"action":"final_answer","answer":"..."}.';

    if (this.options.constitution) {
      prompt += this.options.constitution.buildPromptInjection();
    }
    return prompt;
  }

  private toolDescriptions(task: Task): Array<{ name: string; description: string }> {
    const all = this.tools.getToolDescriptions();
    const allowed = task.tools && task.tools.length > 0 ? new Set(task.tools) : undefined;
    const filtered = allowed ? all.filter(t => allowed.has(t.name)) : all;
    if (filtered.length <= this.relevantToolsAbove) return filtered;
    const relevant = this.tools.getRelevantToolDescriptions(task.description);
    const names = new Set(relevant.map(r => r.name));
    // Always keep the general-purpose tools the agent needs to inspect and verify.
    for (const keep of ['shell_exec', 'file_read', 'file_write']) names.add(keep);
    return filtered.filter(t => names.has(t.name));
  }

  /** Sliding window: always keep the first message (task + state) and the tail. */
  private window(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= this.maxHistory) return messages;
    const first = messages[0];
    let tail = messages.slice(-(this.maxHistory - 1));
    // Keep role alternation sane: the tail should start with a user message.
    while (tail.length > 0 && tail[0].role !== 'user') tail = tail.slice(1);
    return [first, ...tail];
  }

  /** Lenient parser: accepts the action format and DirectExecutor-style shapes. */
  static parseAction(content: string): AgentAction {
    const raw = (content ?? '').trim();
    const json = extractJson(raw);
    if (!json || typeof json !== 'object') {
      return { type: 'malformed', raw };
    }
    const obj = json as Record<string, unknown>;
    const action = typeof obj.action === 'string' ? obj.action : undefined;

    if (action === 'final_answer' || (action === undefined && obj.answer !== undefined)) {
      const answer = obj.answer ?? obj.result ?? obj.final_answer ?? '';
      return { type: 'final_answer', answer: typeof answer === 'string' ? answer : JSON.stringify(answer), plan: asStringArray(obj.plan) };
    }
    if (action === 'ask_consult' || (action === undefined && typeof obj.question === 'string')) {
      return { type: 'ask_consult', question: String(obj.question ?? ''), hypotheses: asStringArray(obj.hypotheses) ?? [] };
    }
    if (action === 'give_up') {
      return { type: 'give_up', reason: String(obj.reason ?? 'no reason given') };
    }

    // tool_call, or DirectExecutor-style {"tool_calls":[...]} / {"steps":[...]}
    let call: Record<string, unknown> | undefined;
    if (action === 'tool_call' || typeof obj.toolName === 'string') {
      call = obj;
    } else if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      call = obj.tool_calls[0] as Record<string, unknown>;
    } else if (Array.isArray(obj.steps) && obj.steps.length > 0) {
      call = obj.steps[0] as Record<string, unknown>;
    }
    if (call && typeof call.toolName === 'string' && call.toolName) {
      return {
        type: 'tool_call',
        toolName: call.toolName,
        toolArgs: sanitizeArgs((call.toolArgs ?? call.args ?? call.input ?? {}) as Record<string, unknown>),
        description: String(call.description ?? obj.thought ?? call.thought ?? call.toolName),
        thought: typeof obj.thought === 'string' ? obj.thought : undefined,
        verify: parseVerify(call.verify ?? obj.verify),
        hypothesis: typeof (call.hypothesis ?? obj.hypothesis) === 'string' ? String(call.hypothesis ?? obj.hypothesis) : undefined,
        plan: asStringArray(obj.plan ?? call.plan),
      };
    }
    return { type: 'malformed', raw };
  }
}

function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?\s*\n?/gi, '').replace(/```/g, '').trim();
  const candidates = [cleaned];
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match && match[0] !== cleaned) candidates.push(match[0]);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try repaired */ }
    try { return JSON.parse(repairJsonStrings(c)); } catch { /* next candidate */ }
  }
  return undefined;
}

/**
 * Small models often put raw newlines and tabs inside JSON string values
 * (typically file contents). Escape them so the object parses; everything
 * outside string literals is left untouched.
 */
function repairJsonStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function parseVerify(v: unknown): StepVerification | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const type = String(o.type ?? '');
  if (!['output_check', 'dom_check', 'command_exit', 'test_result', 'llm_judge'].includes(type)) return undefined;
  return {
    type: type as StepVerification['type'],
    assertion: typeof o.assertion === 'string' ? o.assertion : '',
    ...(typeof o.command === 'string' ? { command: o.command } : {}),
    ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
    ...(typeof o.expectedExitCode === 'number' ? { expectedExitCode: o.expectedExitCode } : {}),
  };
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = typeof v === 'string' && v.length > MAX_TOOL_ARG_CHARS ? v.slice(0, MAX_TOOL_ARG_CHARS) : v;
  }
  return out;
}
