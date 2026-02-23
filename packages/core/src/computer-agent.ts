import {
  type ChatMessage,
  type ModelRequest,
  type BudgetUsage,
  type EnergyConfig,
  ModelTier,
  BudgetExhaustedError,
  generateId,
} from '@joule/shared';
import { ModelProviderRegistry } from '@joule/models';
import type { ToolRegistry } from './tool-registry.js';
import type { BudgetManager, BudgetEnvelopeInstance } from './budget-manager.js';
import type { TraceLogger } from './trace-logger.js';
import type { ModelRouter } from './model-router.js';

// ── System Prompt ──────────────────────────────────────────────

const COMPUTER_AGENT_SYSTEM_PROMPT = `You are an autonomous desktop automation agent on Windows. You can SEE the screen and CONTROL the computer.

## STRATEGY — Pick the FASTEST approach:

**For Office apps (Excel, PowerPoint, Word) and structured tasks:**
USE shell_exec with PowerShell COM automation. This is 10x faster and more reliable than keyboard input.

COMPLETE working Excel example (use this pattern):
$xl = New-Object -ComObject Excel.Application; $xl.Visible = $true; $xl.DisplayAlerts = $false; $wb = $xl.Workbooks.Add(); $ws = $wb.Worksheets.Item(1); $ws.Cells.Item(1,1) = 'Name'; $ws.Cells.Item(1,2) = 'Score'; $ws.Cells.Item(2,1) = 'Alice'; $ws.Cells.Item(2,2) = 95; $ws.Cells.Item(3,1) = 'Bob'; $ws.Cells.Item(3,2) = 87; $hdr = $ws.Range('A1:B1'); $hdr.Font.Bold = $true; $hdr.Interior.Color = 9851952; $hdr.Font.Color = 16777215; $ws.Columns.AutoFit() | Out-Null; $desktop = [Environment]::GetFolderPath('Desktop'); $wb.SaveAs((Join-Path $desktop 'output.xlsx'))

KEY: Use $ws.Cells.Item(row,col) = value (NOT .Value2). Always assign each cell individually. Numbers go without quotes, strings in single quotes.

PowerPoint example (use -1 for msoTrue, 0 for msoFalse — NEVER use [Microsoft.Office.Interop...] types):
$pp = New-Object -ComObject PowerPoint.Application; $pp.Visible = -1; $pres = $pp.Presentations.Add(); $slide = $pres.Slides.Add(1, 2); $slide.FollowMasterBackground = 0; $slide.Background.Fill.ForeColor.RGB = 6697728; $slide.Background.Fill.Solid(); $slide.Shapes.Item(1).TextFrame.TextRange.Text = 'Title'; $slide.Shapes.Item(1).TextFrame.TextRange.Font.Size = 36; $slide.Shapes.Item(1).TextFrame.TextRange.Font.Bold = -1; $slide.Shapes.Item(1).TextFrame.TextRange.Font.Color.RGB = 16777215

For images in PowerPoint: download with System.Net.WebClient then $slide.Shapes.AddPicture($path, 0, -1, left, top, width, height)

**For browsing, visual tasks, or apps without COM:**
Use os_keyboard, os_mouse, os_open, os_window for interactive control.

## Available actions:

1. shell_exec — Run PowerShell commands (PREFERRED for Office apps, file ops, structured work)
   Args: { "command": "PowerShell script here" }
   - Use COM objects for Excel, PowerPoint, Word, Outlook
   - Can do in ONE command what would take 50 keyboard actions
   - Separate statements with semicolons
   - Use single quotes for PowerShell strings

2. os_open — Launch an application or file
   Args: { "target": "excel" | "notepad" | "C:/path/file.xlsx" }

3. os_keyboard — Type text, press keys, keyboard shortcuts
   Type: { "action": "type", "text": "Hello" }
   Key:  { "action": "press", "key": "enter" }
   Hotkey: { "action": "hotkey", "key": "s", "modifiers": ["ctrl"] }

4. os_mouse — Click, double-click, right-click, move, scroll
   { "action": "click", "x": 500, "y": 300 }

5. os_window — Focus, minimize, maximize, close, list windows
   { "action": "focus", "title": "Excel" }

6. os_clipboard — Read/write clipboard
   { "action": "write", "text": "data" }

7. http_fetch — Fetch data from any URL/API (use for real-time data like weather, stocks, news)
   Args: { "url": "https://...", "method": "GET" }
   Returns: { status, body } — the body is the raw response text/JSON
   - Use this FIRST when the task needs real/live data (weather, prices, news, etc.)
   - Free weather API: https://wttr.in/CityName?format=j1 (returns JSON with forecast)
   - Parse the JSON response in the next step to extract data, then create the spreadsheet

## WORKFLOW for tasks needing real data:
Step 1: Use http_fetch to get live data from an API
Step 2: Parse the response (the stdout will contain the JSON)
Step 3: Use shell_exec with COM to create the Office document using that data

## Response format — ONLY raw JSON (no markdown, no backticks):

Multiple actions in a batch:
{
  "done": false,
  "actions": [
    { "action": "shell_exec", "args": { "command": "..." }, "reasoning": "Create Excel with COM" }
  ]
}

Task complete:
{ "done": true, "reasoning": "Task complete because ..." }

## CRITICAL RULES:
1. For Excel/PowerPoint/Word — ALWAYS use shell_exec with COM automation. Never type data via keyboard.
2. Excel cell assignment: $ws.Cells.Item(row,col) = value — assign EVERY cell individually. For numbers use bare values: $ws.Cells.Item(2,2) = 95. For strings use single quotes: $ws.Cells.Item(2,1) = 'Alice'.
3. NEVER use .Value2 property — just use direct assignment: $ws.Cells.Item(r,c) = val.
4. For formatting: .Font.Bold = $true, .Interior.Color = number, .Font.Color = number, .Columns.AutoFit().
5. Always set .Visible = $true and .DisplayAlerts = $false.
6. Save to desktop: $desktop = [Environment]::GetFolderPath('Desktop'); $wb.SaveAs((Join-Path $desktop 'filename.xlsx')).
7. Put the ENTIRE script in one shell_exec command. Separate statements with semicolons.
8. Suppress COM output: pipe to Out-Null or use [void](...).
9. NEVER call .Quit() on COM apps — leave them open and visible so the output can be verified.
10. Keep scripts self-contained — create COM, do work, save. Do NOT close the app after saving.`;

const VALIDATOR_SYSTEM_PROMPT = `You are a strict quality validator for desktop automation output. You receive a screenshot of the result and the original task.

Your job: Critically evaluate whether the output ACTUALLY meets the task requirements.

## Check for these issues:

### Data Quality
- Are cells/fields EMPTY that should have data? (e.g., temperature columns with no numbers)
- Is the data realistic and correct? (not placeholder/lorem ipsum)
- Are numbers actually present where numbers are expected?
- Does the data match what was requested? (right city, right dates, right topic)

### Content Quality (for presentations/documents)
- Do slides have ACTUAL meaningful content, not just titles?
- Are bullet points substantive, not generic filler?
- Is the content RELEVANT to the topic? Not vague or off-topic?
- Are there enough slides/sections as requested?
- Do images actually appear (if requested)?

### Formatting & Structure
- Are headers/titles present and readable?
- Is formatting applied (colors, fonts, alignment)?
- Is the file saved to the correct location?
- Is the app visible and showing the content?

### Completeness
- Were ALL parts of the task addressed?
- Is anything obviously missing or half-done?

### IMPORTANT: Window Context
- If the screenshot shows the CORRECT application (Excel/PowerPoint/Word) with the task content, evaluate that content
- If the screenshot shows an UNRELATED application (browser, code editor, desktop), score based ONLY on whether you can see the target app's content. If you cannot see the output at all, give score 3 and say the app window needs to be brought to front
- Do NOT say "nothing was created" just because a different app is in front — the file may exist but the wrong window is focused

## Response format — ONLY raw JSON:

If the output is GOOD (meets all requirements):
{ "approved": true, "score": 8, "summary": "Content looks complete and well-formatted" }

If the output has ISSUES (needs fixing):
{ "approved": false, "score": 4, "issues": ["Cells B2:B11 are empty - no temperature data", "Missing slide about X topic"], "fix_instructions": "Re-run the COM script and make sure to assign numeric values to temperature cells. Add a slide covering X." }

## Scoring guide:
- 9-10: Excellent — exceeds expectations
- 7-8: Good — meets requirements, minor polish possible
- 5-6: Acceptable — works but has noticeable gaps
- 3-4: Poor — missing significant content or data
- 1-2: Failed — fundamentally broken or empty

Be STRICT. A score of 7+ means approved. Below 7 means issues need fixing.`;

// ── Types ──────────────────────────────────────────────────────

export interface ComputerAgentOptions {
  /** Maximum observe-think-act iterations (default: 30) */
  maxIterations?: number;
  /** Milliseconds to wait before taking a screenshot after an action (default: 1500) */
  screenshotDelay?: number;
  /** Milliseconds to wait between batch actions (default: 150) */
  batchDelay?: number;
  /** Budget preset for the agent run */
  budget?: 'low' | 'medium' | 'high' | 'unlimited';
  /** Energy configuration for tracking */
  energyConfig?: EnergyConfig;
  /** Maximum validation retries before accepting output (default: 2) */
  maxValidationRetries?: number;
}

export interface ComputerAgentAction {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  reasoning: string;
}

export interface ComputerAgentResult {
  success: boolean;
  iterations: number;
  actions: ComputerAgentAction[];
  summary: string;
  budgetUsed: BudgetUsage;
  validationScore?: number;
  validationSummary?: string;
}

// ── Agent ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ComputerAgent {
  private maxIterations: number;
  private screenshotDelay: number;
  private batchDelay: number;
  private maxValidationRetries: number;
  private validationRetryCount = 0;

  constructor(
    private providers: ModelProviderRegistry,
    private tools: ToolRegistry,
    private budget: BudgetManager,
    private tracer: TraceLogger,
    private router: ModelRouter,
    private options?: ComputerAgentOptions,
  ) {
    this.maxIterations = options?.maxIterations ?? 30;
    this.screenshotDelay = options?.screenshotDelay ?? 1500;
    this.batchDelay = options?.batchDelay ?? 150;
    this.maxValidationRetries = options?.maxValidationRetries ?? 2;
  }

  async run(task: string, envelope: BudgetEnvelopeInstance): Promise<ComputerAgentResult> {
    const traceId = generateId('agent');
    this.tracer.createTrace(traceId, `computer-agent`, envelope.envelope);
    const rootSpan = this.tracer.startSpan(traceId, 'computer-agent', { task });

    const actions: ComputerAgentAction[] = [];
    const conversationHistory: ChatMessage[] = [];

    try {
      // Route to a vision-capable LLM
      const decision = await this.router.route('plan', envelope, { complexity: 0.9 });
      const provider = this.providers.get(decision.provider);
      if (!provider) {
        return {
          success: false,
          iterations: 0,
          actions,
          summary: 'No LLM provider available',
          budgetUsed: this.budget.getUsage(envelope),
        };
      }

      for (let i = 0; i < this.maxIterations; i++) {
        this.budget.checkBudget(envelope);

        this.tracer.logEvent(traceId, 'info', {
          type: 'agent_iteration',
          iteration: i + 1,
          maxIterations: this.maxIterations,
        });

        // 1. OBSERVE: take screenshot with base64
        console.log(`  [${i + 1}/${this.maxIterations}] Taking screenshot...`);
        const screenshot = await this.tools.invoke({
          toolName: 'os_screenshot',
          input: { returnBase64: true },
        });
        this.budget.deductToolCall(envelope);

        if (!screenshot.success || !screenshot.output) {
          this.tracer.logEvent(traceId, 'error', {
            type: 'screenshot_failed',
            error: screenshot.error,
          });
          await sleep(2000);
          continue;
        }

        const screenshotData = screenshot.output as { base64?: string; width?: number; height?: number };
        if (!screenshotData.base64) {
          this.tracer.logEvent(traceId, 'error', { type: 'no_base64_data' });
          continue;
        }

        // 2. THINK: send screenshot + conversation to LLM
        console.log(`  [${i + 1}/${this.maxIterations}] Thinking...`);
        const userContent = i === 0
          ? `Task: ${task}\n\nThis is the current screen (${screenshotData.width}x${screenshotData.height}). Analyze what you see and decide what to do. For Office apps (Excel, PowerPoint, Word), use shell_exec with PowerShell COM automation for speed. You can do the entire task in one or two shell_exec commands.`
          : `Actions executed. This is the updated screen (${screenshotData.width}x${screenshotData.height}). Analyze the result. If the task is complete, say done. Otherwise, decide next actions.`;

        const userMessage: ChatMessage = {
          role: 'user',
          content: userContent,
          images: [{
            data: screenshotData.base64,
            mediaType: 'image/png',
          }],
        };
        conversationHistory.push(userMessage);

        const messagesToSend = this.trimConversation(conversationHistory);

        const request: ModelRequest = {
          model: decision.model,
          provider: decision.provider,
          tier: decision.tier as ModelTier,
          system: COMPUTER_AGENT_SYSTEM_PROMPT,
          messages: messagesToSend,
          maxTokens: 4096,
          responseFormat: 'json',
          temperature: 0.1,
        };

        const response = await provider.chat(request);
        this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
        this.budget.deductCost(envelope, response.costUsd);
        if (this.options?.energyConfig) {
          this.budget.deductEnergy(envelope, response.model, response.tokenUsage, this.options.energyConfig);
        }

        this.tracer.logEvent(traceId, 'info', {
          type: 'agent_think',
          iteration: i + 1,
          response: response.content.slice(0, 500),
        });

        // 3. PARSE LLM decision
        let parsed: {
          done?: boolean;
          actions?: Array<{ action: string; args: Record<string, unknown>; reasoning?: string }>;
          action?: string;
          args?: Record<string, unknown>;
          reasoning?: string;
        };
        try {
          parsed = JSON.parse(response.content);
        } catch {
          const jsonMatch = response.content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              parsed = JSON.parse(jsonMatch[0]);
            } catch {
              parsed = { done: false, reasoning: 'Failed to parse LLM response' };
            }
          } else {
            parsed = { done: false, reasoning: 'Failed to parse LLM response' };
          }
        }

        conversationHistory.push({ role: 'assistant', content: response.content });

        // 4. CHECK: is the task done? If so, run VALIDATION
        if (parsed.done) {
          console.log(`  Agent says done: ${parsed.reasoning ?? ''}`);

          // Run validation
          const validation = await this.validate(
            task, provider, decision, envelope, traceId, i + 1,
          );

          if (validation.approved) {
            console.log(`  Validator APPROVED (score: ${validation.score}/10): ${validation.summary}`);
            this.tracer.logEvent(traceId, 'info', {
              type: 'agent_done',
              iteration: i + 1,
              reasoning: parsed.reasoning,
              validationScore: validation.score,
            });

            return {
              success: true,
              iterations: i + 1,
              actions,
              summary: parsed.reasoning ?? 'Task completed',
              budgetUsed: this.budget.getUsage(envelope),
              validationScore: validation.score,
              validationSummary: validation.summary,
            };
          }

          // Validation failed — check if we have retries left
          this.validationRetryCount = (this.validationRetryCount ?? 0) + 1;
          if (this.validationRetryCount > this.maxValidationRetries) {
            console.log(`  Validator REJECTED but max retries (${this.maxValidationRetries}) reached. Accepting anyway.`);
            return {
              success: true,
              iterations: i + 1,
              actions,
              summary: parsed.reasoning ?? 'Task completed (with validation warnings)',
              budgetUsed: this.budget.getUsage(envelope),
              validationScore: validation.score,
              validationSummary: validation.summary,
            };
          }

          // Feed validation critique back to the agent so it fixes the issues
          console.log(`  Validator REJECTED (score: ${validation.score}/10, retry ${this.validationRetryCount}/${this.maxValidationRetries})`);
          console.log(`  Issues: ${validation.issues?.join('; ') ?? 'Unknown'}`);
          console.log(`  Fix: ${validation.fixInstructions ?? 'No instructions'}`);

          conversationHistory.push({
            role: 'user',
            content: `QUALITY CHECK FAILED (score: ${validation.score}/10). The output does NOT meet requirements yet.\n\nIssues found:\n${(validation.issues ?? []).map((issue: string) => `- ${issue}`).join('\n')}\n\nFix instructions: ${validation.fixInstructions ?? 'Address all issues above.'}\n\nPlease fix these issues now. Do NOT say done until the problems are resolved.`,
          });

          this.tracer.logEvent(traceId, 'info', {
            type: 'validation_failed',
            iteration: i + 1,
            score: validation.score,
            issues: validation.issues,
            retryCount: this.validationRetryCount,
          });

          // Continue the loop — agent will take another screenshot and fix
          continue;
        }

        // 5. ACT: execute actions (batch or single)
        const actionList = parsed.actions?.length
          ? parsed.actions
          : (parsed.action ? [{ action: parsed.action, args: parsed.args ?? {}, reasoning: parsed.reasoning }] : []);

        if (actionList.length === 0) {
          this.tracer.logEvent(traceId, 'error', {
            type: 'no_actions',
            response: response.content.slice(0, 200),
          });
          continue;
        }

        console.log(`  [${i + 1}/${this.maxIterations}] Executing ${actionList.length} action(s)...`);

        let batchError = false;
        for (let j = 0; j < actionList.length; j++) {
          const act = actionList[j];

          if (!this.tools.has(act.action)) {
            this.tracer.logEvent(traceId, 'error', { type: 'unknown_tool', tool: act.action });
            conversationHistory.push({
              role: 'user',
              content: `Error: Tool "${act.action}" does not exist. Available: os_open, os_keyboard, os_mouse, os_window, os_clipboard, shell_exec.`,
            });
            batchError = true;
            break;
          }

          const reasoningShort = (act.reasoning ?? '').slice(0, 80);
          console.log(`    [${j + 1}/${actionList.length}] ${act.action}: ${reasoningShort}`);

          // For shell_exec with long commands, increase timeout
          const input = act.action === 'shell_exec'
            ? { ...act.args, timeoutMs: 60_000 }
            : act.args ?? {};

          const toolResult = await this.tools.invoke({
            toolName: act.action,
            input,
            timeoutMs: act.action === 'shell_exec' ? 60_000 : undefined,
          });
          this.budget.deductToolCall(envelope);

          actions.push({
            iteration: i + 1,
            tool: act.action,
            args: act.args ?? {},
            result: toolResult.output,
            reasoning: act.reasoning ?? '',
          });

          this.tracer.logEvent(traceId, 'info', {
            type: 'agent_act',
            iteration: i + 1,
            batchIndex: j,
            tool: act.action,
            success: toolResult.success,
            error: toolResult.error,
          });

          if (!toolResult.success) {
            console.log(`    FAILED: ${toolResult.error}`);
            conversationHistory.push({
              role: 'user',
              content: `Action ${j + 1}/${actionList.length} (${act.action}) failed with error: ${toolResult.error}\nPlease fix the issue and try again.`,
            });
            batchError = true;
            break;
          }

          // Feed data-producing tool outputs back to the LLM so it can use the data
          if (act.action === 'http_fetch' || act.action === 'shell_exec') {
            const output = toolResult.output as Record<string, unknown>;
            const body = (output.body as string) ?? (output.stdout as string) ?? '';
            if (body.length > 0) {
              // Truncate very large responses to fit LLM context
              const truncated = body.length > 8000 ? body.slice(0, 8000) + '\n... (truncated)' : body;
              conversationHistory.push({
                role: 'user',
                content: `Result from ${act.action}:\n${truncated}`,
              });
            }
          }

          // Longer delay after os_open to let app launch
          if (act.action === 'os_open') {
            await sleep(3000);
          } else if (j < actionList.length - 1) {
            await sleep(this.batchDelay);
          }
        }

        if (!batchError) {
          console.log(`    Done (${actionList.length} actions)`);
        }

        // Wait for UI to settle before next screenshot
        await sleep(this.screenshotDelay);
      }

      return {
        success: false,
        iterations: this.maxIterations,
        actions,
        summary: `Max iterations (${this.maxIterations}) reached without completing the task`,
        budgetUsed: this.budget.getUsage(envelope),
      };
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        return {
          success: false,
          iterations: actions.length,
          actions,
          summary: `Budget exhausted: ${err.message}`,
          budgetUsed: this.budget.getUsage(envelope),
        };
      }
      throw err;
    } finally {
      this.tracer.endSpan(traceId, rootSpan);
    }
  }

  /**
   * Validate the agent's output by taking a screenshot and asking
   * a separate LLM call (with a critic prompt) to evaluate quality.
   */
  private async validate(
    task: string,
    provider: { chat: (req: ModelRequest) => Promise<{ content: string; tokenUsage: { totalTokens: number }; costUsd: number; model: string }> },
    decision: { model: string; provider: string; tier: string },
    envelope: BudgetEnvelopeInstance,
    traceId: string,
    iteration: number,
  ): Promise<{ approved: boolean; score: number; summary?: string; issues?: string[]; fixInstructions?: string }> {
    try {
      // Bring the output to front for the screenshot
      const savedFile = this.detectSavedFileFromTask(task);
      const appKeywords = this.detectAppFromTask(task);

      // Strategy: try focus first, fall back to opening the file
      let windowReady = false;

      if (appKeywords) {
        try {
          console.log(`  [Validator] Focusing ${appKeywords} window...`);
          await this.tools.invoke({
            toolName: 'os_window',
            input: { action: 'focus', title: appKeywords },
          });
          windowReady = true;
          await sleep(1000);
        } catch {
          // Focus threw — window doesn't exist
          windowReady = false;
        }
      }

      if (!windowReady && savedFile) {
        // Check if file exists on disk first
        try {
          const checkResult = await this.tools.invoke({
            toolName: 'shell_exec',
            input: { command: `Test-Path '${savedFile}'`, timeoutMs: 5000 },
          });
          const fileExists = (checkResult.output as { stdout?: string })?.stdout?.trim() === 'True';

          if (fileExists) {
            console.log(`  [Validator] Opening ${savedFile} for review...`);
            await this.tools.invoke({
              toolName: 'os_open',
              input: { target: savedFile },
            });
            await sleep(4000); // Wait for app to fully open
          } else {
            console.log(`  [Validator] File not found at ${savedFile}`);
          }
        } catch {
          // Ignore errors in file check
        }
      }

      console.log(`  [Validator] Taking screenshot for quality check...`);
      const screenshot = await this.tools.invoke({
        toolName: 'os_screenshot',
        input: { returnBase64: true },
      });
      this.budget.deductToolCall(envelope);

      const screenshotData = screenshot.output as { base64?: string; width?: number; height?: number };
      if (!screenshotData?.base64) {
        // Can't validate without screenshot — approve by default
        return { approved: true, score: 7, summary: 'Could not take screenshot for validation' };
      }

      console.log(`  [Validator] Evaluating output quality...`);
      const validationRequest: ModelRequest = {
        model: decision.model,
        provider: decision.provider as import('@joule/shared').ModelProviderName,
        tier: decision.tier as ModelTier,
        system: VALIDATOR_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Original task: "${task}"\n\nThis screenshot shows the current output. Evaluate whether it meets the requirements. Be strict — check for empty cells, missing data, placeholder content, incomplete slides, missing images, etc.`,
          images: [{ data: screenshotData.base64, mediaType: 'image/png' as const }],
        }],
        maxTokens: 1024,
        responseFormat: 'json',
        temperature: 0.1,
      };

      const response = await provider.chat(validationRequest);
      this.budget.deductTokens(envelope, response.tokenUsage.totalTokens, response.model);
      this.budget.deductCost(envelope, response.costUsd);

      this.tracer.logEvent(traceId, 'info', {
        type: 'validation',
        iteration,
        response: response.content.slice(0, 500),
      });

      let result: { approved?: boolean; score?: number; summary?: string; issues?: string[]; fix_instructions?: string };
      try {
        result = JSON.parse(response.content);
      } catch {
        const jsonMatch = response.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { result = JSON.parse(jsonMatch[0]); } catch { result = {}; }
        } else {
          result = {};
        }
      }

      return {
        approved: result.approved ?? (result.score !== undefined && result.score >= 7),
        score: result.score ?? 5,
        summary: result.summary,
        issues: result.issues,
        fixInstructions: result.fix_instructions,
      };
    } catch (err) {
      // If validation itself fails, approve to avoid blocking
      console.log(`  [Validator] Error during validation: ${err}`);
      return { approved: true, score: 6, summary: 'Validation error — auto-approved' };
    }
  }

  /**
   * Detect which application the task is likely about, so we can focus its window for validation.
   */
  private detectAppFromTask(task: string): string | null {
    const lower = task.toLowerCase();
    if (lower.includes('powerpoint') || lower.includes('pptx') || lower.includes('presentation') || lower.includes('slides')) return 'PowerPoint';
    if (lower.includes('excel') || lower.includes('xlsx') || lower.includes('spreadsheet')) return 'Excel';
    if (lower.includes('word') || lower.includes('docx') || lower.includes('document')) return 'Word';
    if (lower.includes('notepad')) return 'Notepad';
    if (lower.includes('chrome') || lower.includes('browser')) return 'Chrome';
    return null;
  }

  /**
   * Try to extract a filename from the task that was likely saved to desktop.
   */
  private detectSavedFileFromTask(task: string): string | null {
    // Look for explicit filenames like "Save_Name.pptx" or "filename.xlsx"
    const fileMatch = task.match(/[\w_-]+\.(pptx|xlsx|docx|pdf)/i);
    if (fileMatch) {
      // Assume saved to desktop (as our system prompt instructs)
      const desktopPath = process.env.USERPROFILE
        ? `${process.env.USERPROFILE}\\Desktop\\${fileMatch[0]}`
        : `C:\\Users\\${process.env.USERNAME ?? 'user'}\\Desktop\\${fileMatch[0]}`;
      return desktopPath;
    }
    return null;
  }

  /**
   * Keep conversation manageable for the LLM context window.
   * Keep the first message and the last N messages.
   * Strip images from older messages to save tokens.
   */
  private trimConversation(messages: ChatMessage[], maxMessages = 10): ChatMessage[] {
    if (messages.length <= maxMessages) {
      return messages;
    }

    const first = messages[0];
    const recent = messages.slice(-maxMessages + 1);

    const firstWithoutImages: ChatMessage = {
      role: first.role,
      content: first.content,
    };

    const trimmed: ChatMessage[] = [firstWithoutImages];
    for (let i = 0; i < recent.length; i++) {
      const msg = recent[i];
      const isLastUserMsg = i === recent.length - 1 || (i === recent.length - 2 && recent[recent.length - 1].role === 'assistant');
      if (msg.images && !isLastUserMsg) {
        trimmed.push({ role: msg.role, content: msg.content });
      } else {
        trimmed.push(msg);
      }
    }

    return trimmed;
  }
}
