import {
  type Task,
  type TaskResult,
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

/** A recorded trace span for tool execution or LLM call. */
interface TraceSpan {
  name: string;
  startedAt: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
}

/** Default wall-clock timeout for the entire execution loop (5 minutes). */
const DEFAULT_WALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum number of messages before sliding window kicks in. */
const MAX_MESSAGE_HISTORY = 20;

/** Maximum consecutive calls to the same tool before circuit-breaking. */
const MAX_SAME_TOOL_CONSECUTIVE = 3;

/** Maximum size for a single tool argument value in characters. */
const MAX_TOOL_ARG_SIZE = 50_000;

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
    const wallTimeoutMs = DEFAULT_WALL_TIMEOUT_MS;

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

    // Circuit breaker state: track consecutive calls to same tool
    let lastToolName: string | undefined;
    let sameToolCount = 0;
    const circuitBrokenTools = new Set<string>();

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
        break;
      }

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
          // Circuit breaker: skip tools that have been broken
          if (circuitBrokenTools.has(toolCall.toolName)) {
            toolResults.push(
              `[${toolCall.toolName}] CIRCUIT BROKEN: This tool has been called too many times consecutively. Try a different approach.`,
            );
            continue;
          }

          // Track consecutive same-tool calls
          if (toolCall.toolName === lastToolName) {
            sameToolCount++;
            if (sameToolCount >= MAX_SAME_TOOL_CONSECUTIVE) {
              circuitBrokenTools.add(toolCall.toolName);
              toolResults.push(
                `[${toolCall.toolName}] CIRCUIT BROKEN: Called ${sameToolCount} times consecutively without progress. Try a different tool or approach.`,
              );
              continue;
            }
          } else {
            lastToolName = toolCall.toolName;
            sameToolCount = 1;
          }

          // Sanitize tool argument sizes
          const sanitizedArgs = this.sanitizeToolArgs(toolCall.toolArgs);

          const toolSpanStart = monotonicNow();
          try {
            const result = await this.tools.invoke({
              toolName: toolCall.toolName,
              input: sanitizedArgs,
            });

            const toolDuration = monotonicNow() - toolSpanStart;
            const output = this.truncate(String(result.output ?? 'OK'), 1000);

            if (result.success) {
              toolResults.push(`[${toolCall.toolName}] Success: ${output}`);
            } else {
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
            toolResults.push(`[${toolCall.toolName}] Error: ${errMsg}`);
            traceSpans.push({
              name: `tool:${toolCall.toolName}`,
              startedAt: new Date(Date.now() - toolDuration).toISOString(),
              durationMs: toolDuration,
              metadata: { success: false, error: errMsg, iteration },
            });
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
      status: finalAnswer ? 'completed' : 'failed',
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
        spans: traceSpans.map(s => ({
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
      },
      error: lastError,
      completedAt: isoNow(),
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
    // Try to extract JSON from the response
    const cleaned = content.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      const parsed = JSON.parse(cleaned);

      // Check for final answer
      if (parsed.answer !== undefined) {
        return {
          type: 'final_answer',
          answer: typeof parsed.answer === 'string' ? parsed.answer : JSON.stringify(parsed.answer),
        };
      }

      // Check for tool calls
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        const toolCalls: ParsedToolCall[] = parsed.tool_calls
          .filter((tc: any) => tc.toolName && typeof tc.toolName === 'string')
          .map((tc: any) => ({
            toolName: tc.toolName,
            toolArgs: tc.toolArgs ?? {},
          }));

        if (toolCalls.length > 0) {
          return { type: 'tool_calls', toolCalls };
        }
      }

      // If it has steps (old format), treat first step as tool call
      if (parsed.steps && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        const toolCalls: ParsedToolCall[] = parsed.steps
          .filter((s: any) => s.toolName)
          .map((s: any) => ({
            toolName: s.toolName,
            toolArgs: s.toolArgs ?? {},
          }));

        if (toolCalls.length > 0) {
          return { type: 'tool_calls', toolCalls };
        }
      }

      // Unknown structure — treat as final answer
      return { type: 'final_answer', answer: content };
    } catch {
      // Not valid JSON — treat entire response as final answer
      return { type: 'final_answer', answer: content };
    }
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

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen) + '...[truncated]' : str;
  }
}
