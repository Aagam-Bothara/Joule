import type { TaskResult, BudgetUsage, ExecutionTrace, EfficiencyReport } from '@joule/shared';
import type { ProgressEvent } from '@joule/core';

export function formatResult(result: TaskResult): string {
  const lines: string[] = [];

  lines.push('');
  if (result.status === 'completed') {
    lines.push(`[OK] Task completed`);
  } else if (result.status === 'budget_exhausted') {
    lines.push(`[BUDGET EXHAUSTED] Task stopped`);
    lines.push(`  Reason: ${result.error}`);
    const completed = result.stepResults.filter(s => s.success).length;
    const total = result.stepResults.length;
    lines.push(`  Steps completed: ${completed}/${total}`);
  } else {
    lines.push(`[FAIL] Task failed: ${result.error ?? 'unknown error'}`);
  }

  if (result.result) {
    lines.push('');
    lines.push(result.result);
  }

  lines.push('');
  lines.push(formatBudgetSummary(result.budgetUsed));

  return lines.join('\n');
}

export function formatBudgetSummary(usage: BudgetUsage): string {
  const lines: string[] = [];
  lines.push('--- Budget Summary ---');
  lines.push(`Tokens:      ${usage.tokensUsed} used / ${usage.tokensUsed + usage.tokensRemaining} max`);
  lines.push(`Tool calls:  ${usage.toolCallsUsed} used / ${usage.toolCallsUsed + usage.toolCallsRemaining} max`);
  lines.push(`Escalations: ${usage.escalationsUsed} used / ${usage.escalationsUsed + usage.escalationsRemaining} max`);
  lines.push(`Cost:        $${usage.costUsd.toFixed(4)} / $${(usage.costUsd + usage.costRemaining).toFixed(4)} max`);
  lines.push(`Latency:     ${usage.elapsedMs.toFixed(0)}ms / ${(usage.elapsedMs + usage.latencyRemaining).toFixed(0)}ms max`);

  if (usage.energyWh !== undefined) {
    const maxEnergy = usage.energyRemaining !== undefined ? usage.energyWh + usage.energyRemaining : undefined;
    lines.push(`Energy:      ${formatWh(usage.energyWh)}${maxEnergy !== undefined ? ` / ${formatWh(maxEnergy)} max` : ''}`);
  }
  if (usage.carbonGrams !== undefined) {
    const maxCarbon = usage.carbonRemaining !== undefined ? usage.carbonGrams + usage.carbonRemaining : undefined;
    lines.push(`Carbon:      ${formatCarbon(usage.carbonGrams)}${maxCarbon !== undefined ? ` / ${formatCarbon(maxCarbon)} max` : ''}`);
  }

  return lines.join('\n');
}

export function formatTrace(trace: ExecutionTrace): string {
  return JSON.stringify(trace, null, 2);
}

export function formatWh(wh: number): string {
  if (wh < 0.001) return `${(wh * 1_000_000).toFixed(1)} uWh`;
  if (wh < 1) return `${(wh * 1_000).toFixed(2)} mWh`;
  return `${wh.toFixed(3)} Wh`;
}

export function formatCarbon(grams: number): string {
  if (grams < 0.001) return `${(grams * 1_000).toFixed(2)} mg CO2`;
  return `${grams.toFixed(3)} g CO2`;
}

export function formatEfficiencyReport(report: EfficiencyReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('--- Energy Efficiency Report ---');
  lines.push(`Actual energy:    ${formatWh(report.actualEnergyWh)}`);
  lines.push(`Baseline energy:  ${formatWh(report.baselineEnergyWh)} (if using ${report.baselineModel} for everything)`);
  lines.push(`Energy saved:     ${formatWh(report.savedEnergyWh)} (${report.savingsPercent.toFixed(1)}%)`);
  lines.push(`Carbon saved:     ${formatCarbon(report.savedCarbonGrams)}`);
  if (report.savingsPercent > 0) {
    lines.push(`  -> Joule's SLM-first routing saved ${report.savingsPercent.toFixed(0)}% energy vs cloud LLM baseline`);
  }
  return lines.join('\n');
}

export function formatProgressLine(event: ProgressEvent): string {
  const u = event.usage;
  const parts: string[] = [];
  parts.push(`[${event.phase}]`);
  if (event.stepIndex !== undefined && event.totalSteps !== undefined) {
    parts.push(`Step ${event.stepIndex + 1}/${event.totalSteps}`);
  }
  parts.push(`Tokens: ${u.tokensUsed}`);
  parts.push(`$${u.costUsd.toFixed(4)}`);
  if (u.energyWh !== undefined) {
    parts.push(formatWh(u.energyWh));
  }
  parts.push(`${u.elapsedMs.toFixed(0)}ms`);
  return parts.join(' | ');
}
