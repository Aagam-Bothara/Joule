import { Command } from 'commander';
import * as readline from 'node:readline';
import { generateId, isoNow, type BudgetPresetName, type SessionMessage } from '@joule/shared';
import { Joule, SessionManager } from '@joule/core';
import { formatWh, formatCarbon } from '../output/formatter.js';
import { setupJoule } from '../setup.js';

export const chatCommand = new Command('chat')
  .description('Interactive chat mode with streaming responses')
  .option('-b, --budget <preset>', 'Budget per message: low, medium, high, unlimited', 'medium')
  .option('--session-budget <usd>', 'Total session cost limit in USD', '1.00')
  .option('--no-stream', 'Disable streaming (wait for complete response)')
  .option('--resume <session-id>', 'Resume a previous session')
  .option('--list', 'List previous sessions')
  .option('--max-history <n>', 'Max history tokens to include (default: 4000)', '4000')
  .action(async (options) => {
    const joule = new Joule();
    await joule.initialize();
    await setupJoule(joule);

    const sessionManager = new SessionManager();

    // List sessions and exit
    if (options.list) {
      const sessions = await sessionManager.list();
      if (sessions.length === 0) {
        console.log('No saved sessions.');
      } else {
        console.log('Previous sessions:');
        for (const entry of sessions) {
          console.log(`  ${entry.id} | ${entry.messageCount} msgs | ${entry.updatedAt} | ${entry.preview}`);
        }
      }
      return;
    }

    // Create or resume session
    let session = options.resume
      ? await sessionManager.load(options.resume)
      : await sessionManager.create();

    if (!session) {
      console.error(`Session not found: ${options.resume}`);
      return;
    }

    const sessionBudgetUsd = parseFloat(options.sessionBudget);
    const useStreaming = options.stream !== false;
    const maxHistoryTokens = parseInt(options.maxHistory, 10);

    console.log('Joule Interactive Chat');
    console.log(`Session: ${session.id}`);
    console.log(`Per-message budget: ${options.budget}${useStreaming ? ' (streaming)' : ''}`);
    console.log(`Session limit: $${sessionBudgetUsd.toFixed(2)}`);
    if (options.resume) {
      console.log(`Resumed with ${session.messages.length} messages`);
    }
    console.log('Commands: /budget, /energy, /history, /save, /quit');
    console.log('');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'joule> ',
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
      const input = line.trim();

      if (!input) {
        rl.prompt();
        return;
      }

      if (input === '/quit' || input === '/exit') {
        await sessionManager.save(session!);
        printSessionSummary(session!.metadata);
        rl.close();
        return;
      }

      if (input === '/budget') {
        console.log(`Session: $${session!.metadata.totalCostUsd.toFixed(4)} / $${sessionBudgetUsd.toFixed(2)}`);
        console.log(`Messages: ${session!.metadata.messageCount}`);
        console.log(`Remaining: $${(sessionBudgetUsd - session!.metadata.totalCostUsd).toFixed(4)}`);
        rl.prompt();
        return;
      }

      if (input === '/energy') {
        console.log(`Total energy: ${formatWh(session!.metadata.totalEnergyWh)}`);
        console.log(`Total carbon: ${formatCarbon(session!.metadata.totalCarbonGrams)}`);
        console.log(`Total tokens: ${session!.metadata.totalTokens}`);
        rl.prompt();
        return;
      }

      if (input === '/history') {
        if (session!.messages.length === 0) {
          console.log('No messages in this session.');
        } else {
          for (const msg of session!.messages) {
            const prefix = msg.role === 'user' ? 'You' : 'Joule';
            const preview = msg.content.length > 120 ? msg.content.slice(0, 120) + '...' : msg.content;
            console.log(`  [${prefix}] ${preview}`);
          }
        }
        rl.prompt();
        return;
      }

      if (input === '/save') {
        await sessionManager.save(session!);
        console.log(`Session saved: ${session!.id}`);
        rl.prompt();
        return;
      }

      if (session!.metadata.totalCostUsd >= sessionBudgetUsd) {
        console.log('[SESSION BUDGET EXHAUSTED] No more messages allowed.');
        await sessionManager.save(session!);
        printSessionSummary(session!.metadata);
        rl.close();
        return;
      }

      // Add user message to history
      const userMessage: SessionMessage = {
        role: 'user',
        content: input,
        timestamp: isoNow(),
      };
      sessionManager.addMessage(session!, userMessage);

      // Trim history to fit token budget, exclude current input (it goes in task.description)
      const historyMessages = sessionManager.trimHistory(session!.messages, maxHistoryTokens);
      const contextHistory = historyMessages.slice(0, -1);

      const task = {
        id: generateId('chat'),
        description: input,
        budget: options.budget as BudgetPresetName,
        messages: contextHistory.length > 0 ? contextHistory : undefined,
        createdAt: new Date().toISOString(),
      };

      try {
        let responseText = '';

        if (useStreaming) {
          console.log('');
          let hasStartedOutput = false;

          for await (const event of joule.executeStream(task)) {
            if (event.type === 'chunk' && event.chunk) {
              if (!event.chunk.done) {
                hasStartedOutput = true;
                process.stdout.write(event.chunk.content);
                responseText += event.chunk.content;
              }
            } else if (event.type === 'result' && event.result) {
              if (hasStartedOutput) {
                console.log('');
              }
              sessionManager.updateMetadata(session!, {
                totalCostUsd: event.result.budgetUsed.costUsd,
                totalTokens: event.result.budgetUsed.tokensUsed,
                totalEnergyWh: event.result.budgetUsed.energyWh ?? 0,
                totalCarbonGrams: event.result.budgetUsed.carbonGrams ?? 0,
              });

              if (event.result.result && !hasStartedOutput) {
                responseText = event.result.result;
              }

              console.log(`  [$${event.result.budgetUsed.costUsd.toFixed(4)} | ${event.result.budgetUsed.tokensUsed} tokens | ${formatWh(event.result.budgetUsed.energyWh ?? 0)}]`);
            }
          }
        } else {
          const result = await joule.execute(task);
          sessionManager.updateMetadata(session!, {
            totalCostUsd: result.budgetUsed.costUsd,
            totalTokens: result.budgetUsed.tokensUsed,
            totalEnergyWh: result.budgetUsed.energyWh ?? 0,
            totalCarbonGrams: result.budgetUsed.carbonGrams ?? 0,
          });

          if (result.result) {
            responseText = result.result;
            console.log('');
            console.log(result.result);
            console.log('');
          }

          console.log(`  [$${result.budgetUsed.costUsd.toFixed(4)} | ${result.budgetUsed.tokensUsed} tokens | ${formatWh(result.budgetUsed.energyWh ?? 0)}]`);
        }

        // Add assistant response to history
        if (responseText) {
          const assistantMessage: SessionMessage = {
            role: 'assistant',
            content: responseText,
            timestamp: isoNow(),
          };
          sessionManager.addMessage(session!, assistantMessage);
        }

        // Auto-save after each exchange
        await sessionManager.save(session!);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      joule.shutdown();
      process.exit(0);
    });
  });

function printSessionSummary(metadata: { messageCount: number; totalCostUsd: number; totalEnergyWh: number; totalCarbonGrams: number; totalTokens: number }): void {
  console.log('');
  console.log('--- Session Summary ---');
  console.log(`Messages:    ${metadata.messageCount}`);
  console.log(`Total cost:  $${metadata.totalCostUsd.toFixed(4)}`);
  console.log(`Total energy: ${formatWh(metadata.totalEnergyWh)}`);
  console.log(`Total carbon: ${formatCarbon(metadata.totalCarbonGrams)}`);
  console.log(`Total tokens: ${metadata.totalTokens}`);
}
