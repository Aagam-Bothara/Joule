import {
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
  ToolNotFoundError,
  ConstitutionViolationError,
  monotonicNow,
} from '@joule/shared';
import type { ConstitutionEnforcer } from './constitution.js';

interface RegisteredTool {
  definition: ToolDefinition;
  source: 'builtin' | 'plugin' | 'mcp' | 'programmatic';
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private constitution?: ConstitutionEnforcer;

  /** Attach a constitution enforcer — called once during initialization */
  setConstitution(enforcer: ConstitutionEnforcer): void {
    this.constitution = enforcer;
  }

  register(tool: ToolDefinition, source: 'builtin' | 'plugin' | 'mcp' | 'programmatic' = 'programmatic'): void {
    this.tools.set(tool.name, { definition: tool, source });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolDescriptions(): Array<{ name: string; description: string }> {
    return this.list().map(t => {
      let desc = t.description;

      // Extract argument info from Zod schema for planner context
      try {
        if (t.inputSchema && typeof t.inputSchema === 'object' && '_def' in t.inputSchema) {
          const def = (t.inputSchema as any)._def;
          const shape = def?.typeName === 'ZodObject' ? def.shape?.() : null;
          if (shape) {
            const args = Object.entries(shape).map(([key, val]: [string, any]) => {
              const argDesc = val?._def?.description || val?.description || '';
              const typeName = val?._def?.typeName?.replace('Zod', '').toLowerCase() || 'any';
              return argDesc ? `${key} (${typeName}): ${argDesc}` : `${key} (${typeName})`;
            });
            if (args.length > 0) {
              desc += ` | Args: ${args.join(', ')}`;
            }
          }
        }
      } catch {
        // Schema introspection failed — use plain description
      }

      return { name: t.name, description: desc };
    });
  }

  async invoke(invocation: ToolInvocation): Promise<ToolResult> {
    const registered = this.tools.get(invocation.toolName);
    if (!registered) {
      throw new ToolNotFoundError(invocation.toolName);
    }

    // CONSTITUTION GUARD — check before execution
    if (this.constitution) {
      try {
        const violation = this.constitution.validateToolCall(invocation);
        if (violation) {
          // Non-critical violations return as tool errors (critical ones throw above)
          return {
            toolName: invocation.toolName,
            success: false,
            error: `Constitution violation [${violation.ruleId}]: ${violation.description}`,
            durationMs: 0,
          };
        }
      } catch (err) {
        if (err instanceof ConstitutionViolationError) {
          // Critical violation — propagate as tool error, don't execute
          return {
            toolName: invocation.toolName,
            success: false,
            error: `CRITICAL Constitution violation [${err.ruleId}]: ${err.message}`,
            durationMs: 0,
          };
        }
        // Other errors — don't let constitution checks break tool execution
      }
    }

    const tool = registered.definition;
    const startTime = monotonicNow();
    const timeoutMs = invocation.timeoutMs ?? tool.timeoutMs ?? 30_000;

    try {
      // Validate input
      const parsedInput = tool.inputSchema.parse(invocation.input);

      // Execute with timeout
      const result = await Promise.race([
        tool.execute(parsedInput),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      // Validate output
      const parsedOutput = tool.outputSchema.parse(result);

      return {
        toolName: invocation.toolName,
        success: true,
        output: parsedOutput,
        durationMs: monotonicNow() - startTime,
      };
    } catch (error) {
      return {
        toolName: invocation.toolName,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: monotonicNow() - startTime,
      };
    }
  }

  /**
   * Create a new ToolRegistry containing only the specified tools.
   * Used for per-agent tool isolation in multi-agent crews.
   * The returned registry shares the same ConstitutionEnforcer.
   */
  createFiltered(allowedTools?: string[]): ToolRegistry {
    const filtered = new ToolRegistry();
    if (this.constitution) {
      filtered.setConstitution(this.constitution);
    }

    if (!allowedTools || allowedTools.length === 0) {
      for (const [, registered] of this.tools) {
        filtered.register(registered.definition, registered.source);
      }
    } else {
      for (const toolName of allowedTools) {
        const registered = this.tools.get(toolName);
        if (registered) {
          filtered.register(registered.definition, registered.source);
        }
      }
    }

    return filtered;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  clear(): void {
    this.tools.clear();
  }
}
