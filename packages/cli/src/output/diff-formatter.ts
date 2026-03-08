/**
 * CLI diff formatter — formats ReplayDiff for terminal output with colors.
 */

import type { ReplayDiff } from '@joule/core';

const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

export function formatReplayDiff(diff: ReplayDiff): string {
  const lines: string[] = [];

  // Header
  lines.push(`${COLORS.bold}${COLORS.cyan}Replay Diff${COLORS.reset}`);
  lines.push('');

  // Budget comparison
  lines.push(`${COLORS.bold}Budget Comparison:${COLORS.reset}`);
  const { budgetComparison: b } = diff;
  const tokenSign = b.tokenDelta >= 0 ? '+' : '';
  const costSign = b.costDelta >= 0 ? '+' : '';
  const tokenColor = b.tokenDelta > 0 ? COLORS.red : COLORS.green;
  const costColor = b.costDelta > 0 ? COLORS.red : COLORS.green;

  lines.push(`  Tokens:  ${b.originalTokens.toLocaleString()} → ${b.replayTokens.toLocaleString()}  ${tokenColor}(${tokenSign}${b.tokenDelta.toLocaleString()})${COLORS.reset}`);
  lines.push(`  Cost:    $${b.originalCost.toFixed(4)} → $${b.replayCost.toFixed(4)}  ${costColor}(${costSign}$${b.costDelta.toFixed(4)})${COLORS.reset}`);
  lines.push('');

  // Step comparison
  lines.push(`${COLORS.bold}Step Comparison:${COLORS.reset}`);
  const { stepComparison: s } = diff;
  lines.push(`  Steps:  ${s.originalStepCount} → ${s.replayStepCount}`);
  if (s.toolsAdded.length > 0) {
    lines.push(`  ${COLORS.green}+ Tools added: ${s.toolsAdded.join(', ')}${COLORS.reset}`);
  }
  if (s.toolsRemoved.length > 0) {
    lines.push(`  ${COLORS.red}- Tools removed: ${s.toolsRemoved.join(', ')}${COLORS.reset}`);
  }
  lines.push('');

  // Output diff
  lines.push(`${COLORS.bold}Output Diff:${COLORS.reset}`);
  if (!diff.outputChanged) {
    lines.push(`  ${COLORS.dim}(identical output)${COLORS.reset}`);
  } else {
    for (const line of diff.outputDiff) {
      if (line.startsWith('+ ')) {
        lines.push(`  ${COLORS.green}${line}${COLORS.reset}`);
      } else if (line.startsWith('- ')) {
        lines.push(`  ${COLORS.red}${line}${COLORS.reset}`);
      } else {
        lines.push(`  ${COLORS.dim}${line}${COLORS.reset}`);
      }
    }
  }

  return lines.join('\n');
}

export function formatReplayDiffJson(diff: ReplayDiff): string {
  return JSON.stringify(diff, null, 2);
}
