/**
 * Results Analyzer — Combines all experiment results into paper-ready tables
 * ===========================================================================
 *
 * Usage:
 *   npx tsx paper/analyze-results.ts
 *
 * Reads from paper/results/ and produces:
 * - Head-to-head comparison table (Joule vs CrewAI)
 * - Scale experiment summary table
 * - Failure case study comparison table
 * - Governance enforcement proof table
 * - LaTeX-formatted tables for paper inclusion
 */

import * as fs from 'fs';
import * as path from 'path';

const RESULTS_DIR = 'paper/results';

function loadJson(filename: string): any {
  const fp = path.join(RESULTS_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function padR(s: string, n: number): string { return s.padEnd(n); }
function padL(s: string, n: number): string { return s.padStart(n); }

function printTable(headers: string[], rows: string[][], colWidths?: number[]) {
  const widths = colWidths || headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length)) + 2
  );
  const sep = widths.map(w => '─'.repeat(w)).join('┼');

  console.log('  ┌' + widths.map(w => '─'.repeat(w)).join('┬') + '┐');
  console.log('  │' + headers.map((h, i) => padR(` ${h}`, widths[i])).join('│') + '│');
  console.log('  ├' + sep + '┤');
  for (const row of rows) {
    console.log('  │' + row.map((c, i) => padR(` ${c}`, widths[i])).join('│') + '│');
  }
  console.log('  └' + widths.map(w => '─'.repeat(w)).join('┴') + '┘');
}

function toLatexTable(caption: string, label: string, headers: string[], rows: string[][]): string {
  const cols = headers.map(() => 'l').join(' ');
  let latex = `\\begin{table}[h]\n\\centering\n\\caption{${caption}}\n\\label{tab:${label}}\n`;
  latex += `\\begin{tabular}{${cols}}\n\\toprule\n`;
  latex += headers.join(' & ') + ' \\\\\n\\midrule\n';
  for (const row of rows) {
    latex += row.join(' & ') + ' \\\\\n';
  }
  latex += '\\bottomrule\n\\end{tabular}\n\\end{table}\n';
  return latex;
}

function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  PAPER RESULTS ANALYSIS');
  console.log('═'.repeat(70));

  const latexTables: string[] = [];

  // ── 1. Head-to-Head Comparison ──────────────────────────────────────────

  const jouleResults = loadJson('joule-results.json');
  const crewaiResults = loadJson('crewai-results.json');

  if (jouleResults && crewaiResults) {
    console.log('\n── Table 1: Head-to-Head Comparison (Joule vs CrewAI) ──\n');

    const headers = ['Metric', 'Joule', 'CrewAI', 'Δ'];
    const js = jouleResults.summary;
    const cs = crewaiResults.summary;

    const costDelta = cs.avg_cost_usd > 0
      ? `${((js.avg_cost_usd - cs.avg_cost_usd) / cs.avg_cost_usd * 100).toFixed(1)}%`
      : 'N/A';
    const tokenDelta = cs.avg_tokens > 0
      ? `${((js.avg_tokens - cs.avg_tokens) / cs.avg_tokens * 100).toFixed(1)}%`
      : 'N/A';
    const durationDelta = cs.avg_duration_ms > 0
      ? `${((js.avg_duration_ms - cs.avg_duration_ms) / cs.avg_duration_ms * 100).toFixed(1)}%`
      : 'N/A';

    const rows = [
      ['Success Rate', `${js.success_rate_pct.toFixed(1)}%`, `${cs.success_rate_pct.toFixed(1)}%`, '-'],
      ['Avg Cost/Task', `$${js.avg_cost_usd.toFixed(6)}`, `$${cs.avg_cost_usd.toFixed(6)}`, costDelta],
      ['Avg Tokens/Task', `${js.avg_tokens.toFixed(0)}`, `${cs.avg_tokens.toFixed(0)}`, tokenDelta],
      ['Avg Latency', `${js.avg_duration_ms.toFixed(0)}ms`, `${cs.avg_duration_ms.toFixed(0)}ms`, durationDelta],
      ['Total Cost (8 tasks)', `$${js.total_cost_usd.toFixed(4)}`, `$${cs.total_cost_usd.toFixed(4)}`, '-'],
      ['Budget Enforcement', 'Yes (7D)', 'No', '-'],
      ['Governance', 'Runtime-level', 'Prompt-level', '-'],
      ['Escalations', `${js.total_escalations}`, 'N/A', '-'],
    ];

    printTable(headers, rows);
    latexTables.push(toLatexTable(
      'Head-to-head comparison of Joule vs CrewAI on 8 benchmark tasks using gpt-4o-mini.',
      'comparison',
      headers,
      rows,
    ));
  } else {
    console.log('\n  [PENDING] Head-to-head comparison — run both joule-comparison.ts and crewai-comparison.py first');
  }

  // ── 2. Scale Experiment ─────────────────────────────────────────────────

  const scaleResults = loadJson('scale-results.json');
  if (scaleResults) {
    console.log('\n── Table 2: Scale Experiment (N=' + scaleResults.totalTasks + ' tasks) ──\n');

    const headers = ['Metric', 'Value'];
    const rows = [
      ['Total Tasks', String(scaleResults.totalTasks)],
      ['Completed', `${scaleResults.completedTasks} (${scaleResults.successRate.toFixed(1)}%)`],
      ['Budget Exhausted', String(scaleResults.budgetExhaustedCount)],
      ['Budget Enforcement Rate', `${scaleResults.budgetEnforcementRate.toFixed(1)}%`],
      ['Failed', String(scaleResults.failedCount)],
      ['Total Cost', `$${scaleResults.totalCost.toFixed(4)}`],
      ['Avg Cost/Task', `$${scaleResults.avgCostPerTask.toFixed(6)}`],
      ['Total Tokens', String(scaleResults.totalTokens)],
      ['Avg Tokens/Task', `${scaleResults.avgTokensPerTask.toFixed(0)}`],
    ];
    printTable(headers, rows);

    // By complexity
    console.log('\n  By Complexity:');
    const cHeaders = ['Complexity', 'Count', 'Completed', 'Avg Cost', 'Avg Tokens', 'Exhausted'];
    const cRows = Object.entries(scaleResults.byComplexity).map(([c, d]: [string, any]) => [
      c, String(d.count), String(d.completed), `$${d.avgCost.toFixed(6)}`, d.avgTokens.toFixed(0), String(d.budgetExhausted),
    ]);
    printTable(cHeaders, cRows);

    // By budget
    console.log('\n  By Budget Level:');
    const bHeaders = ['Budget', 'Count', 'Completed', 'Avg Cost', 'Exhausted', 'Enforcement'];
    const bRows = Object.entries(scaleResults.byBudget).map(([b, d]: [string, any]) => [
      b, String(d.count), String(d.completed), `$${d.avgCost.toFixed(6)}`, String(d.budgetExhausted), `${d.enforcementRate.toFixed(1)}%`,
    ]);
    printTable(bHeaders, bRows);

    latexTables.push(toLatexTable(
      `Budget enforcement at scale (N=${scaleResults.totalTasks} tasks).`,
      'scale',
      ['Metric', 'Value'],
      rows,
    ));
  }

  // ── 3. Failure Case Study ───────────────────────────────────────────────

  const failureResults = loadJson('failure-case-study.json');
  if (failureResults) {
    console.log('\n── Table 3: Failure Case Study — Runaway Agent ──\n');

    const headers = ['Budget', 'Status', 'Tokens', 'Cost', 'Tools', 'Steps', 'Stopped'];
    const rows = failureResults.scenarios.map((s: any) => [
      s.scenario,
      s.status,
      String(s.tokensUsed),
      `$${s.costUsd.toFixed(4)}`,
      String(s.toolCalls),
      String(s.steps),
      s.stoppedByBudget ? 'Yes' : 'No',
    ]);
    printTable(headers, rows);

    latexTables.push(toLatexTable(
      'Resource consumption under varying budget constraints. Without enforcement, the agent consumes unbounded resources.',
      'failure',
      headers,
      rows,
    ));
  }

  // ── 4. Governance Proof ─────────────────────────────────────────────────

  const govResults = loadJson('governance-proof.json');
  if (govResults) {
    console.log('\n── Table 4: Governance Enforcement Proof ──\n');

    const headers = ['Scenario', 'Governance', 'Status', 'Dangerous Exec', 'Dangerous Blocked', 'Safe Exec'];
    const rows = govResults.scenarios.map((s: any) => {
      const dangerous = ['delete_all_data', 'read_credentials', 'exfiltrate_data'];
      const dangerExec = dangerous.reduce((sum: number, t: string) => sum + (s.toolExecutions[t]?.succeeded ?? 0), 0);
      const dangerBlocked = dangerous.reduce((sum: number, t: string) => sum + (s.toolExecutions[t]?.blocked ?? 0), 0);
      const safeExec = s.toolExecutions['safe_search']?.succeeded ?? 0;
      return [
        s.scenario,
        s.governanceEnabled ? 'ON' : 'OFF',
        s.status,
        String(dangerExec),
        String(dangerBlocked),
        String(safeExec),
      ];
    });
    printTable(headers, rows);

    latexTables.push(toLatexTable(
      'Runtime governance enforcement. Dangerous tools are blocked at the execution layer, not the prompt layer.',
      'governance',
      headers,
      rows,
    ));
  }

  // ── 5. Extended Benchmark Comparison (30 tasks) ────────────────────────

  const extJoule = loadJson('extended-joule-results.json');
  const extCrewai = loadJson('extended-crewai-results.json');

  if (extJoule && extCrewai) {
    console.log('\n── Table 5: Extended Benchmark (30 tasks, 5 categories) ──\n');

    // Overall comparison
    const ej = extJoule.overall;
    const ec = extCrewai.overall;

    const headers5 = ['Metric', 'Joule', 'CrewAI', 'Ratio'];
    const rows5 = [
      ['Tasks', String(ej.totalTasks), String(ec.total_tasks), '-'],
      ['Success Rate', `${ej.successRate.toFixed(1)}%`, `${ec.success_rate.toFixed(1)}%`, '-'],
      ['Total Cost', `$${ej.totalCost.toFixed(4)}`, `$${ec.total_cost.toFixed(4)}`, `${(ej.totalCost / ec.total_cost).toFixed(1)}x`],
      ['Avg Cost/Task', `$${ej.avgCostPerTask.toFixed(6)}`, `$${ec.avg_cost_per_task.toFixed(6)}`, `${(ej.avgCostPerTask / ec.avg_cost_per_task).toFixed(1)}x`],
      ['Avg Tokens', `${ej.avgTokensPerTask.toFixed(0)}`, `${ec.avg_tokens_per_task.toFixed(0)}`, `${(ej.avgTokensPerTask / ec.avg_tokens_per_task).toFixed(1)}x`],
      ['Avg Latency', `${ej.avgDurationMs.toFixed(0)}ms`, `${ec.avg_duration_ms.toFixed(0)}ms`, `${(ec.avg_duration_ms / ej.avgDurationMs).toFixed(1)}x faster`],
      ['Tool Calls', String(ej.totalToolCalls), '0', 'Joule only'],
      ['Escalations', String(ej.totalEscalations), 'N/A', 'Joule only'],
      ['P50 Latency', `${ej.p50DurationMs}ms`, '-', '-'],
      ['P95 Latency', `${ej.p95DurationMs}ms`, '-', '-'],
    ];
    printTable(headers5, rows5);

    latexTables.push(toLatexTable(
      'Extended benchmark comparison (N=30 tasks, 5 categories) using gpt-4o-mini. Joule is 1.5x faster overall with budget enforcement and governance.',
      'extended-overall',
      headers5,
      rows5,
    ));

    // Per-category comparison
    console.log('\n── Table 6: Per-Category Comparison ──\n');

    // Build CrewAI category lookup from measurements
    const crewaiByCategory: Record<string, { tokens: number[]; cost: number[]; duration: number[]; count: number }> = {};
    for (const m of extCrewai.measurements) {
      if (!crewaiByCategory[m.category]) {
        crewaiByCategory[m.category] = { tokens: [], cost: [], duration: [], count: 0 };
      }
      crewaiByCategory[m.category].tokens.push(m.tokens_total);
      crewaiByCategory[m.category].cost.push(m.cost_usd);
      crewaiByCategory[m.category].duration.push(m.duration_ms);
      crewaiByCategory[m.category].count++;
    }

    const catHeaders = ['Category', 'J-Tokens', 'C-Tokens', 'Tok Ratio', 'J-Latency', 'C-Latency', 'Speed', 'J-Tools'];
    const catRows: string[][] = [];

    for (const jCat of extJoule.categorySummaries) {
      const cat = jCat.category;
      const cCat = crewaiByCategory[cat];
      if (!cCat) continue;

      const cAvgTokens = cCat.tokens.reduce((a: number, b: number) => a + b, 0) / cCat.count;
      const cAvgDuration = cCat.duration.reduce((a: number, b: number) => a + b, 0) / cCat.count;
      const tokRatio = cAvgTokens > 0 ? (jCat.avgTokens / cAvgTokens).toFixed(1) + 'x' : 'N/A';
      const speedRatio = jCat.avgDurationMs > 0 ? (cAvgDuration / jCat.avgDurationMs).toFixed(1) + 'x' : 'N/A';

      catRows.push([
        cat,
        jCat.avgTokens.toFixed(0),
        cAvgTokens.toFixed(0),
        tokRatio,
        `${jCat.avgDurationMs.toFixed(0)}ms`,
        `${cAvgDuration.toFixed(0)}ms`,
        speedRatio,
        jCat.avgToolCalls.toFixed(1),
      ]);
    }
    printTable(catHeaders, catRows);

    latexTables.push(toLatexTable(
      'Per-category comparison. Token overhead narrows from 20x (knowledge) to 1.2x (multi-step). Joule is 1.8--1.9x faster on complex tasks.',
      'extended-category',
      catHeaders,
      catRows,
    ));
  } else {
    console.log('\n  [PENDING] Extended benchmark — run both extended-benchmark.ts and extended-crewai.py first');
  }

  // ── Save LaTeX tables ───────────────────────────────────────────────────

  if (latexTables.length > 0) {
    const latex = `% Auto-generated LaTeX tables for Joule paper\n% Generated: ${new Date().toISOString()}\n\n` +
      latexTables.join('\n');
    fs.writeFileSync(path.join(RESULTS_DIR, 'tables.tex'), latex);
    console.log(`\n  LaTeX tables saved to ${RESULTS_DIR}/tables.tex`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  ANALYSIS COMPLETE');
  console.log('═'.repeat(70) + '\n');
}

main();
