import {
  type Task,
  type TaskResult,
  type TaskStatus,
  type AgentDefinition,
  type ModelRequest,
  type ChatMessage,
  type BudgetUsage,
  ModelTier,
  generateId,
  isoNow,
  monotonicNow,
} from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import { getSiteKnowledgeRegistry } from '@joule/tools';
import type { BudgetManager, BudgetEnvelopeInstance } from './budget-manager.js';
import { ModelRouter } from './model-router.js';
import { ToolRegistry } from './tool-registry.js';
import type { ProgressCallback } from './task-executor.js';
import { AgentLifecycleTracker } from './adaptive/lifecycle.js';
import { extractJson } from './adaptive/step-agent.js';
import { VerifiedEditGate } from './verified-edit.js';

/**
 * A parsed tool call extracted from the LLM's JSON response.
 */
interface ParsedToolCall {
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/**
 * A parsed LLM response — either tool calls to execute, or a final answer.
 */
interface ParsedResponse {
  type: 'tool_calls' | 'final_answer';
  toolCalls?: ParsedToolCall[];
  answer?: string;
}

/** Normalize the call shapes seen in model replies, including nested wrappers. */
function toolCallsFrom(value: unknown): ParsedToolCall[] {
  if (Array.isArray(value)) return value.flatMap(toolCallsFrom);
  if (value === null || typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  const toolName = [obj.toolName, obj.tool, obj.name]
    .find((name): name is string => typeof name === 'string' && name.length > 0);
  if (toolName) {
    const args = obj.toolArgs ?? obj.tool_args ?? obj.args ?? obj.input ?? {};
    return [{ toolName, toolArgs: args !== null && typeof args === 'object' && !Array.isArray(args)
      ? args as Record<string, unknown> : {} }];
  }
  if (Array.isArray(obj.tool_calls)) return toolCallsFrom(obj.tool_calls);
  if (Array.isArray(obj.steps)) return toolCallsFrom(obj.steps);
  return [];
}

/** A recorded trace span for tool execution or LLM call. */
interface TraceSpan {
  name: string;
  startedAt: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

/** A call's identity: the tool plus its arguments, with key order normalized. */
function callSignature(toolName: string, args: Record<string, unknown>): string {
  const stable = Object.keys(args)
    .sort()
    .map(key => `${key}=${JSON.stringify(args[key])}`)
    .join('&');
  return `${toolName}(${stable})`;
}

/** Default wall-clock timeout for the entire execution loop (5 minutes). */
const DEFAULT_WALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum number of messages before sliding window kicks in. */
const MAX_MESSAGE_HISTORY = 20;

/**
 * Maximum consecutive times the *same call* may be repeated before it is
 * refused.
 *
 * The signal for a stuck agent is an identical call — same tool, same
 * arguments — returning the same result over and over. Reaching for one tool
 * repeatedly is not that: reading three files in a row, or running a command
 * and then re-running it after an edit, is ordinary work on a repository.
 * Counting tool identity instead of call identity misread that as a loop and
 * took the tool away: in Dataset F it disabled `file_read` and `shell_exec` for
 * four testers, which then had nothing left to work with.
 */
const MAX_IDENTICAL_TOOL_CALLS = 3;

/** Maximum size for a single tool argument value in characters. */
const MAX_TOOL_ARG_SIZE = 50_000;

/** Repository tools already cap their payloads; preserve enough to show a file or test failure. */
const REPO_READ_RESULT_CHARS = 16_000;
const REPO_SHELL_RESULT_CHARS = 10_000;
const DEFAULT_TOOL_RESULT_CHARS = 1_000;

/**
 * DirectExecutor — OpenClaw-style reactive agent loop.
 *
 * Instead of the 7-phase pipeline (spec → classify → plan → critique → simulate → act → synthesize),
 * this executor runs a tight loop:
 *
 *   1. Build system prompt with agent instructions + tool descriptions
 *   2. Call LLM with conversation history
 *   3. Parse response — either tool calls or final answer
 *   4. If tool calls: execute them, append results to history, loop back to step 2
 *   5. If final answer: return it
 *
 * This reduces the minimum LLM calls from 4+ to 1-3, making crew agents ~3-5x faster.
 *
 * Production hardening:
 * - Wall-clock timeout to prevent infinite execution
 * - Sliding message window to bound memory usage
 * - Circuit breaker for repeated tool calls
 * - Tool result sanitization against prompt injection
 * - Empty/malformed response detection
 * - Trace span recording for debugging
 */
export class DirectExecutor {
  constructor(
    private budgetManager: BudgetManager,
    private router: ModelRouter,
    private tools: ToolRegistry,
    private providers: ModelProviderRegistry,
  ) {}

  async execute(
    task: Task,
    envelope: BudgetEnvelopeInstance,
    agent: AgentDefinition,
    onProgress?: ProgressCallback,
  ): Promise<TaskResult> {
    const startTime = monotonicNow();
    const taskId = task.id;
    const traceId = generateId('direct-trace');
    const maxIterations = agent.maxIterations ?? 10;
    const wallTimeoutMs = agent.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;

    // Opt-in verified-edit gate: without a policy on the task this stays
    // undefined and every write behaves exactly as it did before.
    const gate = task.verifiedEdit ? new VerifiedEditGate(task.verifiedEdit) : undefined;
    if (gate) await gate.establishBaseline();

    // The same tracker the adaptive path uses, so direct-mode agents produce
    // comparable events. Identity comes from the task the crew built; a
    // standalone run falls back to the agent definition's own id and role.
    const lifecycle = new AgentLifecycleTracker({
      taskId,
      agentId: task.agentId ?? agent.id,
      agentRole: task.agentRole ?? agent.role,
      parentTaskId: task.parentTaskId,
    });

    // Build system prompt with tool descriptions + site knowledge
    const systemPrompt = this.buildSystemPrompt(agent, task.description);

    // Conversation history — starts with the task
    const messages: ChatMessage[] = [
      { role: 'user', content: task.description },
    ];

    let totalTokens = 0;
    let iteration = 0;
    let finalAnswer: string | undefined;
    let lastError: string | undefined;
    const traceSpans: TraceSpan[] = [];

    // Loop detection: the last call made, and how many times in a row it has
    // been repeated. No tool is ever taken away — only an identical repeat is
    // refused, so the agent keeps every tool it was given.
    let lastCallSignature: string | undefined;
    let identicalCallCount = 0;

    // Report initial progress
    onProgress?.({
      phase: 'executing',
      stepIndex: 0,
      totalSteps: maxIterations,
      usage: this.budgetManager.getUsage(envelope),
    });

    while (iteration < maxIterations) {
      iteration++;

      // Wall-clock timeout check
      const elapsed = monotonicNow() - startTime;
      if (elapsed > wallTimeoutMs) {
        lastError = `Wall-clock timeout exceeded (${Math.round(wallTimeoutMs / 1000)}s)`;
        break;
      }

      // Check budget before LLM call
      const usage = this.budgetManager.getUsage(envelope);
      if (usage.tokensRemaining <= 0 || usage.costRemaining <= 0) {
        lastError = 'Budget exhausted during direct execution';
        break;
      }

      // Route to appropriate model
      let decision;
      try {
        decision = await this.router.route('execute', envelope, {
          complexity: 0.7, // Use capable model for tool-use agents
        });
      } catch {
        // Fall back to SLM if routing fails
        try {
          decision = await this.router.route('classify', envelope);
        } catch (err) {
          lastError = `No available model: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }
      }

      const provider = this.providers.get(decision.provider);
      if (!provider) {
        lastError = `Provider not available: ${decision.provider}`;
        break;
      }

      // Sliding window: keep system message context fresh but bound message count
      const windowedMessages = this.applyMessageWindow(messages);

      // Make LLM call
      const llmSpanStart = monotonicNow();
      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier as ModelTier,
        system: systemPrompt,
        messages: windowedMessages,
        temperature: 0.3,
        responseFormat: 'json',
      };

      let response;
      lifecycle.modelStart(decision.model, { iteration, tier: decision.tier, provider: decision.provider });
      try {
        response = await provider.chat(request);
      } catch (err) {
        lastError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
        traceSpans.push({
          name: 'llm_call_failed',
          startedAt: new Date(Date.now() - (monotonicNow() - llmSpanStart)).toISOString(),
          durationMs: monotonicNow() - llmSpanStart,
          metadata: { error: lastError, iteration },
        });
        // The loop ends here, so the run dies inside the model call.
        lifecycle.fail(err, { iteration, phase: 'model' });
        break;
      }
      lifecycle.modelEnd(response.model, { iteration, tier: decision.tier });

      const llmDuration = monotonicNow() - llmSpanStart;
      traceSpans.push({
        name: 'llm_call',
        startedAt: new Date(Date.now() - llmDuration).toISOString(),
        durationMs: llmDuration,
        metadata: { model: decision.model, tokens: response.tokenUsage.totalTokens, iteration },
      });

      // Track budget — deductTokens handles cost approximation internally
      // Do NOT also call deductCost to avoid double-counting
      totalTokens += response.tokenUsage.totalTokens;
      this.budgetManager.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);

      // Report progress
      onProgress?.({
        phase: 'executing',
        stepIndex: iteration,
        totalSteps: maxIterations,
        usage: this.budgetManager.getUsage(envelope),
      });

      // Detect empty/malformed responses — fail instead of treating as success
      if (!response.content || response.content.trim().length === 0) {
        lastError = 'LLM returned empty response';
        traceSpans.push({
          name: 'empty_response',
          startedAt: isoNow(),
          durationMs: 0,
          metadata: { iteration },
        });
        break;
      }

      // Parse response
      const parsed = this.parseResponse(response.content);

      if (parsed.type === 'final_answer') {
        finalAnswer = parsed.answer;
        break;
      }

      // Execute tool calls
      if (parsed.toolCalls && parsed.toolCalls.length > 0) {
        // Append assistant message to history
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: string[] = [];

        for (const toolCall of parsed.toolCalls) {
          // Sanitize tool argument sizes
          const sanitizedArgs = this.sanitizeToolArgs(toolCall.toolArgs);

          // Refuse a call that is identical to the one just made: it would
          // return the same result again. A different argument is different
          // work, and the tool stays available either way.
          const signature = callSignature(toolCall.toolName, sanitizedArgs);
          if (signature === lastCallSignature) {
            identicalCallCount++;
            if (identicalCallCount >= MAX_IDENTICAL_TOOL_CALLS) {
              toolResults.push(
                `[${toolCall.toolName}] REPEATED CALL: this exact call has already been made ${identicalCallCount - 1} time(s) `
                + 'and returned the same result. Change the arguments, or try something else.',
              );
              continue;
            }
          } else {
            lastCallSignature = signature;
            identicalCallCount = 1;
          }

          const toolSpanStart = monotonicNow();
          // Only real tool work counts as waiting; the circuit-breaker and
          // argument checks above are in-memory and stay out of the timeline.
          lifecycle.toolStart(toolCall.toolName, { iteration });
          // What the call did, reported on the closing lifecycle event. Without
          // it a record shows that an agent called `file_write` but not whether
          // the write landed — the difference between an agent that tried to
          // contribute and one that succeeded.
          const outcome: { ok?: boolean; rolledBack?: boolean; error?: string } = {};
          // Opt-in: remember the file this write is about to replace, so a
          // regression can be undone.
          const guarded = gate?.guards(toolCall.toolName, sanitizedArgs) === true;
          const before = guarded ? gate!.snapshot(sanitizedArgs) : undefined;
          try {
            const result = await this.tools.invoke({
              toolName: toolCall.toolName,
              input: sanitizedArgs,
            });

            const toolDuration = monotonicNow() - toolSpanStart;
            const outputLimit = toolCall.toolName === 'repo_read' ? REPO_READ_RESULT_CHARS
              : toolCall.toolName === 'repo_shell' ? REPO_SHELL_RESULT_CHARS : DEFAULT_TOOL_RESULT_CHARS;
            const output = this.truncate(this.renderToolOutput(result.output), outputLimit);

            if (result.success && before) {
              // The write landed; keep it only if the workspace still verifies.
              const decision = await gate!.review(before, toolCall.toolName, task.agentRole ?? agent.role ?? toolCall.toolName);
              outcome.ok = decision.kept;
              outcome.rolledBack = decision.rolledBack;
              toolResults.push(decision.kept
                ? `[${toolCall.toolName}] Success: ${output}${decision.message ? ` (${decision.message})` : ''}`
                : `[${toolCall.toolName}] REJECTED: ${decision.message}`);
            } else if (result.success) {
              outcome.ok = true;
              toolResults.push(`[${toolCall.toolName}] Success: ${output}`);
            } else {
              outcome.ok = false;
              outcome.error = result.error ?? 'Unknown error';
              toolResults.push(`[${toolCall.toolName}] Error: ${result.error ?? 'Unknown error'}`);
            }

            traceSpans.push({
              name: `tool:${toolCall.toolName}`,
              startedAt: new Date(Date.now() - toolDuration).toISOString(),
              durationMs: toolDuration,
              metadata: { success: result.success, iteration },
            });
          } catch (err) {
            const toolDuration = monotonicNow() - toolSpanStart;
            const errMsg = err instanceof Error ? err.message : String(err);
            outcome.ok = false;
            outcome.error = errMsg;
            toolResults.push(`[${toolCall.toolName}] Error: ${errMsg}`);
            traceSpans.push({
              name: `tool:${toolCall.toolName}`,
              startedAt: new Date(Date.now() - toolDuration).toISOString(),
              durationMs: toolDuration,
              metadata: { success: false, error: errMsg, iteration },
            });
          } finally {
            // A throwing tool must not leave the lifecycle stuck in tool_wait;
            // a failed tool call is reported to the agent and the run continues.
            lifecycle.toolEnd(toolCall.toolName, { iteration, ...outcome });
          }
        }

        // Sanitize tool results before injecting back into conversation
        // Wrap in clear XML delimiters to prevent prompt injection
        const sanitizedResults = toolResults.map(r => this.sanitizeToolResult(r));
        messages.push({
          role: 'user',
          content: `<tool_results>\n${sanitizedResults.join('\n')}\n</tool_results>\n\nContinue with the task. If done, respond with {"answer": "your final answer"}.`,
        });
      } else {
        // No tool calls and no final answer — malformed response, don't silently pass
        lastError = 'LLM returned response without tool_calls or answer';
        traceSpans.push({
          name: 'malformed_response',
          startedAt: isoNow(),
          durationMs: 0,
          metadata: { rawContent: this.truncate(response.content, 200), iteration },
        });
        break;
      }
    }

    if (!finalAnswer && !lastError) {
      lastError = `Reached max iterations (${maxIterations}) without completing`;
      // Provide the last assistant message as partial context
      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      finalAnswer = lastAssistant
        ? `(Partial - max iterations reached) ${this.truncate(lastAssistant.content, 500)}`
        : undefined;
    }

    // Close the lifecycle on whatever ended the loop, matching `status` below.
    const status: TaskStatus = finalAnswer ? 'completed' : 'failed';
    if (!lifecycle.isTerminal()) {
      if (status === 'completed') lifecycle.complete({ iterations: iteration });
      else lifecycle.fail(lastError, { iterations: iteration });
    }
    const lifecycleEvents = lifecycle.events;
    const lifecycleMetrics = lifecycle.metrics();

    const elapsedMs = monotonicNow() - startTime;
    const finalUsage = this.budgetManager.getUsage(envelope);
    const budgetUsed: BudgetUsage = {
      tokensUsed: totalTokens,
      tokensRemaining: Math.max(0, finalUsage.tokensRemaining),
      toolCallsUsed: iteration,
      toolCallsRemaining: Math.max(0, maxIterations - iteration),
      escalationsUsed: 0,
      escalationsRemaining: 0,
      costUsd: finalUsage.costUsd,
      costRemaining: Math.max(0, finalUsage.costRemaining),
      elapsedMs,
      latencyRemaining: 0,
    };

    // Report completion
    onProgress?.({
      phase: 'synthesizing',
      stepIndex: iteration,
      totalSteps: iteration,
      usage: budgetUsed,
    });

    return {
      id: generateId('result'),
      taskId,
      traceId,
      status,
      result: finalAnswer,
      stepResults: [],
      budgetUsed,
      trace: {
        traceId,
        taskId,
        startedAt: new Date(Date.now() - elapsedMs).toISOString(),
        completedAt: isoNow(),
        totalDurationMs: elapsedMs,
        budget: {
          allocated: envelope.envelope,
          used: budgetUsed,
        },
        spans: [
          ...traceSpans.map(s => ({
            id: generateId('span'),
            traceId,
            name: s.name,
            startTime: new Date(s.startedAt).getTime(),
            endTime: new Date(s.startedAt).getTime() + s.durationMs,
            events: s.metadata ? [{
              id: generateId('evt'),
              traceId,
              type: 'info' as const,
              timestamp: new Date(s.startedAt).getTime(),
              wallClock: s.startedAt,
              duration: s.durationMs,
              data: s.metadata,
            }] : [],
            children: [],
          })),
          // Lifecycle transitions as `agent_lifecycle` events: the same type and
          // payload the adaptive path logs through TraceLogger, so a consumer
          // reads both modes the same way.
          ...(lifecycleEvents.length > 0 ? [{
            id: generateId('span'),
            traceId,
            name: 'agent-lifecycle',
            startTime: lifecycle.startTime,
            endTime: lifecycleEvents[lifecycleEvents.length - 1].timestamp,
            events: lifecycleEvents.map(e => ({
              id: generateId('evt'),
              traceId,
              type: 'agent_lifecycle' as const,
              timestamp: e.timestamp,
              wallClock: new Date(Date.now() - (monotonicNow() - e.timestamp)).toISOString(),
              data: { ...e } as Record<string, unknown>,
            })),
            children: [],
          }] : []),
        ],
      },
      error: lastError,
      completedAt: isoNow(),
      lifecycle: lifecycleEvents,
      lifecycleMetrics,
      ...(gate ? { verifiedEdits: gate.stats } : {}),
    };
  }

  /**
   * Build system prompt with agent instructions, tool descriptions, and site knowledge.
   * This is the key to the direct approach — everything the agent needs in one prompt.
   */
  private buildSystemPrompt(agent: AgentDefinition, taskDescription: string): string {
    const toolDescriptions = this.tools.getToolDescriptions();

    let prompt = `You are: ${agent.role}

${agent.instructions}

## Response Format

You MUST respond with ONLY a raw JSON object (no markdown, no code fences, no extra text).

### When you need to use tools:
Respond with:
{"tool_calls": [{"toolName": "<tool_name>", "toolArgs": {<arguments>}}]}

You can call multiple tools at once. Tool results will be sent back to you.

### When you are done (task complete):
Respond with:
{"answer": "<your final comprehensive answer>"}`;

    if (toolDescriptions.length > 0) {
      prompt += '\n\n## Available Tools\n';
      for (const tool of toolDescriptions) {
        prompt += `\n- **${tool.name}**: ${tool.description}`;
      }
    } else {
      prompt += '\n\nYou have NO tools available. Respond directly with {"answer": "..."}.';
    }

    // Inject site knowledge for known websites
    try {
      const siteRegistry = getSiteKnowledgeRegistry();
      const siteContext = siteRegistry.buildContextForAgent(taskDescription, agent.instructions);
      if (siteContext) {
        prompt += '\n\n' + siteContext;
      }
    } catch {
      // Site knowledge is optional — don't fail if unavailable
    }

    if (agent.outputSchema) {
      prompt += `\n\n## Output Schema\nYour final answer MUST be valid JSON conforming to: ${JSON.stringify(agent.outputSchema)}`;
    }

    return prompt;
  }

  /**
   * Parse LLM response into either tool calls or final answer.
   * Handles various response formats gracefully.
   */
  private parseResponse(content: string): ParsedResponse {
    // Some model replies use XML tags for the call name and JSON arguments.
    // Parse the paired tags, including replies whose outer closing tag is bad.
    if (/<tool_calls>/i.test(content)) {
      const xmlCalls = [...content.matchAll(/<tool_name>\s*([^<>]+?)\s*<\/tool_name>\s*<tool_args>\s*([\s\S]*?)\s*<\/tool_args>/gi)]
        .flatMap(match => toolCallsFrom({ toolName: match[1].trim(), toolArgs: extractJson(match[2]) }));
      if (xmlCalls.length > 0) return { type: 'tool_calls', toolCalls: xmlCalls };
    }

    // `extractJson` is the same tolerant reader the adaptive path uses: it
    // copes with code fences, prose around JSON, raw newlines inside
    // strings, and a container closed early with text still trailing it. A strict
    // parse treats all of those as "the agent is finished", which silently ends
    // a run that was in the middle of calling three tools.
    const parsed = extractJson(content);

    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
      // Check for final answer
      if (!Array.isArray(parsed) && (parsed as Record<string, unknown>).answer !== undefined) {
        const answer = (parsed as Record<string, unknown>).answer;
        return {
          type: 'final_answer',
          answer: typeof answer === 'string' ? answer : JSON.stringify(answer),
        };
      }

      const toolCalls = toolCallsFrom(parsed);
      if (toolCalls.length > 0) return { type: 'tool_calls', toolCalls };
    }

    // No recognizable call or answer: preserve the reply as the answer.
    return { type: 'final_answer', answer: content };
  }

  /**
   * Apply sliding window to messages to prevent unbounded growth.
   * Always keeps the first message (task description) and the most recent messages.
   */
  private applyMessageWindow(messages: ChatMessage[]): ChatMessage[] {
    if (messages.length <= MAX_MESSAGE_HISTORY) {
      return messages;
    }
    const first = messages[0];
    const recent = messages.slice(-(MAX_MESSAGE_HISTORY - 1));
    return [first, ...recent];
  }

  /**
   * Sanitize tool results to mitigate prompt injection.
   * Strips any attempts to close our XML delimiter tags.
   */
  private sanitizeToolResult(result: string): string {
    return result
      .replace(/<\/tool_results>/gi, '&lt;/tool_results&gt;')
      .replace(/<tool_results>/gi, '&lt;tool_results&gt;');
  }

  /**
   * Sanitize tool arguments to prevent oversized inputs.
   */
  private sanitizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > MAX_TOOL_ARG_SIZE) {
        sanitized[key] = value.slice(0, MAX_TOOL_ARG_SIZE);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * A tool result as text the model can read.
   *
   * Tools return objects — `file_read` gives `{content, sizeBytes, truncated}`,
   * `shell_exec` gives `{stdout, stderr, exitCode}` — and `String(anObject)` is
   * "[object Object]". That is what every direct-mode agent was shown for every
   * file it read and every command it ran, so an agent asked to review code
   * received nothing to review. The other execution paths have always used JSON
   * here; this makes the direct loop agree with them.
   */
  private renderToolOutput(output: unknown): string {
    if (output === undefined || output === null) return 'OK';
    if (typeof output === 'string') return output;
    return JSON.stringify(output) ?? 'OK';
  }

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen) + '...[truncated]' : str;
  }
}
