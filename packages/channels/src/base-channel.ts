import type { Joule, SessionManager } from '@joule/core';
import type { TaskResult, BudgetPresetName } from '@joule/shared';
import { generateId, isoNow } from '@joule/shared';
import type { ChannelMessage, ChannelResponse } from './types.js';

export abstract class BaseChannel {
  protected sessions = new Map<string, string>(); // channelKey → sessionId
  protected budgetPreset: BudgetPresetName;

  constructor(
    protected joule: Joule,
    protected sessionManager: SessionManager,
    budgetPreset?: BudgetPresetName,
  ) {
    this.budgetPreset = budgetPreset ?? 'medium';
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  protected async handleMessage(msg: ChannelMessage): Promise<ChannelResponse> {
    const channelKey = msg.threadId
      ? `${msg.platform}:${msg.channelId}:${msg.threadId}`
      : `${msg.platform}:${msg.channelId}`;

    // Get or create session for this channel/thread
    let sessionId = this.sessions.get(channelKey);
    let session;

    if (sessionId) {
      session = await this.sessionManager.load(sessionId);
    }

    if (!session) {
      session = await this.sessionManager.create();
      sessionId = session.id;
      this.sessions.set(channelKey, sessionId);
    }

    // Build message content — include attachment descriptions for multi-modal
    let content = msg.text;
    if (msg.attachments && msg.attachments.length > 0) {
      const attachmentDesc = msg.attachments.map((a) => {
        const name = a.filename || 'unnamed';
        const typeLabel = a.type.charAt(0).toUpperCase() + a.type.slice(1);
        return `[${typeLabel}: ${name} (${a.mimeType})]`;
      }).join('\n');
      content = `${content}\n\nAttachments:\n${attachmentDesc}`;
    }

    // Add user message to session
    this.sessionManager.addMessage(session, {
      role: 'user',
      content,
      timestamp: msg.timestamp,
    });

    // Create task with conversation history
    const task = {
      id: generateId('task'),
      description: content,
      budget: this.budgetPreset,
      messages: session.messages,
      createdAt: isoNow(),
    };

    // Execute and collect result
    let result: TaskResult | undefined;
    for await (const event of this.joule.executeStream(task)) {
      if (event.type === 'result' && event.result) {
        result = event.result;
      }
    }

    if (!result) {
      return { text: 'Sorry, I was unable to process that request.', threadId: msg.threadId };
    }

    // Add assistant response to session
    const responseText = result.result ?? 'Task completed.';
    this.sessionManager.addMessage(session, {
      role: 'assistant',
      content: responseText,
      timestamp: isoNow(),
    });

    // Update session metadata
    this.sessionManager.updateMetadata(session, {
      totalCostUsd: result.budgetUsed.costUsd,
      totalTokens: result.budgetUsed.tokensUsed,
      totalEnergyWh: result.budgetUsed.energyWh ?? 0,
      totalCarbonGrams: result.budgetUsed.carbonGrams ?? 0,
    });

    await this.sessionManager.save(session);

    return {
      text: this.formatResponse(result),
      threadId: msg.threadId,
      metadata: {
        taskId: result.taskId,
        energyWh: result.budgetUsed.energyWh ?? 0,
        carbonGrams: result.budgetUsed.carbonGrams ?? 0,
        tokensUsed: result.budgetUsed.tokensUsed,
        costUsd: result.budgetUsed.costUsd,
        latencyMs: result.budgetUsed.elapsedMs,
      },
    };
  }

  protected formatResponse(result: TaskResult): string {
    const text = result.result ?? 'Task completed.';
    const energy = result.budgetUsed.energyWh ?? 0;
    const carbon = result.budgetUsed.carbonGrams ?? 0;

    // Format energy badge
    const energyStr = energy < 0.001
      ? `${(energy * 1000).toFixed(2)} mWh`
      : `${energy.toFixed(4)} Wh`;
    const carbonStr = carbon < 0.001
      ? `${(carbon * 1000).toFixed(2)} mg CO2`
      : `${carbon.toFixed(4)} g CO2`;

    return `${text}\n\n_Energy: ${energyStr} | Carbon: ${carbonStr}_`;
  }
}
