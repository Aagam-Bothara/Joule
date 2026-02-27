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

    // Build system prompt with tool descriptions
    const systemPrompt = this.buildSystemPrompt(agent);

    // Conversation history — starts with the task
    const messages: ChatMessage[] = [
      { role: 'user', content: task.description },
    ];

    let totalTokens = 0;
    let totalCost = 0;
    let iteration = 0;
    let finalAnswer: string | undefined;
    let lastError: string | undefined;

    // Report initial progress
    onProgress?.({
      phase: 'executing',
      stepIndex: 0,
      totalSteps: maxIterations,
      usage: this.budgetManager.getUsage(envelope),
    });

    while (iteration < maxIterations) {
      iteration++;

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

      // Make LLM call
      const request: ModelRequest = {
        model: decision.model,
        provider: decision.provider,
        tier: decision.tier as ModelTier,
        system: systemPrompt,
        messages,
        temperature: 0.3,
        responseFormat: 'json',
      };

      let response;
      try {
        response = await provider.chat(request);
      } catch (err) {
        lastError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }

      // Track budget
      totalTokens += response.tokenUsage.totalTokens;
      totalCost += response.costUsd;
      this.budgetManager.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budgetManager.deductCost(envelope, response.costUsd);

      // Report progress
      onProgress?.({
        phase: 'executing',
        stepIndex: iteration,
        totalSteps: maxIterations,
        usage: this.budgetManager.getUsage(envelope),
      });

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
          try {
            const result = await this.tools.invoke({
              toolName: toolCall.toolName,
              input: toolCall.toolArgs,
            });

            if (result.success) {
              toolResults.push(
                `[${toolCall.toolName}] Success: ${this.truncate(String(result.output ?? 'OK'), 1000)}`,
              );
            } else {
              toolResults.push(
                `[${toolCall.toolName}] Error: ${result.error ?? 'Unknown error'}`,
              );
            }
          } catch (err) {
            toolResults.push(
              `[${toolCall.toolName}] Error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        // Append tool results as user message (feedback loop)
        messages.push({
          role: 'user',
          content: `Tool results:\n${toolResults.join('\n')}\n\nContinue with the task. If done, respond with {"answer": "your final answer"}.`,
        });
      } else {
        // No tool calls and no final answer — treat raw text as answer
        finalAnswer = response.content;
        break;
      }
    }

    if (!finalAnswer && !lastError) {
      lastError = `Reached max iterations (${maxIterations}) without completing`;
      // Use last LLM response as partial answer
      finalAnswer = messages.length > 1
        ? `(Partial - max iterations reached) Last response available in execution trace.`
        : undefined;
    }

    const elapsedMs = monotonicNow() - startTime;
    const budgetUsed: BudgetUsage = {
      tokensUsed: totalTokens,
      tokensRemaining: Math.max(0, this.budgetManager.getUsage(envelope).tokensRemaining),
      toolCallsUsed: iteration,
      toolCallsRemaining: Math.max(0, maxIterations - iteration),
      escalationsUsed: 0,
      escalationsRemaining: 0,
      costUsd: totalCost,
      costRemaining: Math.max(0, this.budgetManager.getUsage(envelope).costRemaining),
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
        budget: { allocated: {} as any, used: {} as any },
        spans: [],
      },
      error: lastError,
      completedAt: isoNow(),
    };
  }

  /**
   * Build system prompt with agent instructions and tool descriptions.
   * This is the key to the direct approach — everything the agent needs in one prompt.
   */
  private buildSystemPrompt(agent: AgentDefinition): string {
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

  private truncate(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
  }
}
