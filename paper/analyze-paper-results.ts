/**
 * Unified Paper Results Analyzer
 * ===============================
 * Reads results from all frameworks and ablation configs, computes:
 * - Mean ± stddev for all metrics (3 runs per task)
 * - Per-category breakdowns with error bars
 * - Ablation comparison tables
 * - Pruning metrics (per-category pruning rate, repaired edges)
 * - Quality scores comparison
 * - LaTeX tables ready for paper inclusion
 *
 * Usage:
 *   npx tsx paper/analyze-paper-results.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const RESULTS_DIR = 'paper/results';
const CATEGORIES = ['qa', 'summarization', 'research', 'code_generation', 'multi_step'];
const FRAMEWORKS = ['joule', 'crewai', 'langchain'];
const ABLATION_CONFIGS = ['full', 'no-pruning', 'no-prompt-opt', 'no-routing'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadJson(filename: string): any {
  const fp = path.join(RESULTS_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf-8'));
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function fmt(val: number, decimals: number): string {
  return val.toFixed(decimals);
}

function fmtPM(m: number, s: number, decimals: number): string {
  return `${m.toFixed(decimals)} $\\pm$ ${s.toFixed(decimals)}`;
}

interface Measurement {
  task_id: string;
  category: string;
  run: number;
  prompt_tokens: number;
  completion_tokens: number;
  num_llm_calls: number;
  energy_wh: number;
  task_success: 0 | 1;
  latency_ms: number;
  quality_score?: number;
  pruning_total_results?: number;
  pruning_pruned_count?: number;
  pruning_repaired_edges?: number;
  pruning_rate?: number;
}

interface ResultFile {
  framework: string;
  overall: Record<string, any>;
  category_summaries: Array<Record<string, any>>;
  measurements: Measurement[];
}

function toLatexTable(caption: string, label: string, headers: string[], rows: string[][], colSpec?: string): string {
  const cols = colSpec || headers.map(() => 'l').join(' ');
  let latex = `\\begin{table}[h]\n\\centering\n\\caption{${caption}}\n\\label{tab:${label}}\n`;
  latex += `\\begin{tabular}{${cols}}\n\\toprule\n`;
  latex += headers.join(' & ') + ' \\\\\n\\midrule\n';
  for (const row of rows) {
    latex += row.join(' & ') + ' \\\\\n';
  }
  latex += '\\bottomrule\n\\end{tabular}\n\\end{table}\n';
  return latex;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '='.repeat(75));
  console.log('  UNIFIED PAPER RESULTS ANALYZER (3 frameworks, ablation, error bars)');
  console.log('='.repeat(75));

  const latexTables: string[] = [];

  // ── Load all results ────────────────────────────────────────────────────

  const results: Record<string, ResultFile | null> = {};

  // Baselines
  for (const fw of FRAMEWORKS) {
    if (fw === 'joule') {
      // Joule has multiple ablation configs
      for (const config of ABLATION_CONFIGS) {
        results[`joule-${config}`] = loadJson(`paper-joule-${config}-results.json`);
      }
      // Also try the legacy single-file format
      if (!results['joule-full']) {
        results['joule-full'] = loadJson('paper-joule-results.json');
      }
    } else {
      results[fw] = loadJson(`paper-${fw}-results.json`);
    }
  }

  const loaded = Object.entries(results).filter(([, v]) => v !== null);
  console.log(`\n  Loaded ${loaded.length} result files: ${loaded.map(([k]) => k).join(', ')}`);

  if (loaded.length === 0) {
    console.log('\n  No results found. Run the benchmarks first:');
    console.log('    npx tsx paper/paper-benchmark.ts --runs=3');
    console.log('    python paper/paper-crewai.py --runs 3');
    console.log('    python paper/paper-langchain.py --runs 3');
    return;
  }

  // ── Table 1: Three-Way Overall Comparison ───────────────────────────────

  const joule = results['joule-full'];
  const crewai = results['crewai'];
  const langchain = results['langchain'];

  const activeFrameworks: [string, ResultFile][] = [];
  if (joule) activeFrameworks.push(['Joule', joule]);
  if (crewai) activeFrameworks.push(['CrewAI', crewai]);
  if (langchain) activeFrameworks.push(['LangChain', langchain]);

  if (activeFrameworks.length >= 2) {
    console.log('\n-- Table 1: Overall Comparison (mean +/- stddev across 3 runs) --\n');

    const metrics = [
      'Success Rate', 'Avg Prompt Tokens', 'Avg Completion Tokens',
      'Avg LLM Calls', 'Avg Energy (Wh)', 'Avg Latency (ms)', 'Avg Quality (1-5)',
    ];
    const headers = ['Metric', ...activeFrameworks.map(([name]) => name)];
    const rows: string[][] = [];

    for (const metric of metrics) {
      const row: string[] = [metric];
      for (const [, data] of activeFrameworks) {
        const ms = data.measurements.filter(m => m.task_success === 1);
        let values: number[];
        switch (metric) {
          case 'Success Rate':
            row.push(`${(data.measurements.filter(m => m.task_success === 1).length / data.measurements.length * 100).toFixed(1)}\\%`);
            continue;
          case 'Avg Prompt Tokens': values = ms.map(m => m.prompt_tokens); break;
          case 'Avg Completion Tokens': values = ms.map(m => m.completion_tokens); break;
          case 'Avg LLM Calls': values = ms.map(m => m.num_llm_calls); break;
          case 'Avg Energy (Wh)': values = ms.map(m => m.energy_wh); break;
          case 'Avg Latency (ms)': values = ms.map(m => m.latency_ms); break;
          case 'Avg Quality (1-5)': values = ms.filter(m => m.quality_score != null).map(m => m.quality_score!); break;
          default: values = []; break;
        }
        // Group by task_id, compute per-task mean, then overall mean +/- stddev
        const byTask = new Map<string, number[]>();
        for (const m of ms) {
          const key = m.task_id;
          if (!byTask.has(key)) byTask.set(key, []);
          const val = metric === 'Avg Prompt Tokens' ? m.prompt_tokens :
                      metric === 'Avg Completion Tokens' ? m.completion_tokens :
                      metric === 'Avg LLM Calls' ? m.num_llm_calls :
                      metric === 'Avg Energy (Wh)' ? m.energy_wh :
                      metric === 'Avg Latency (ms)' ? m.latency_ms :
                      metric === 'Avg Quality (1-5)' ? (m.quality_score ?? 0) : 0;
          byTask.get(key)!.push(val);
        }
        const taskMeans = [...byTask.values()].map(vals => mean(vals));
        const decimals = metric.includes('Energy') ? 6 : metric.includes('Quality') ? 2 : 0;
        row.push(fmtPM(mean(taskMeans), stddev(taskMeans), decimals));
      }
      rows.push(row);
    }

    // Print console
    const colW = [24, ...activeFrameworks.map(() => 28)];
    console.log('  ' + headers.map((h, i) => h.padEnd(colW[i])).join(''));
    console.log('  ' + colW.map(w => '-'.repeat(w)).join(''));
    for (const row of rows) {
      console.log('  ' + row.map((c, i) => c.padEnd(colW[i])).join(''));
    }

    latexTables.push(toLatexTable(
      `Overall comparison across ${activeFrameworks.length} frameworks (50 tasks, gpt-4o-mini, 3 runs per task). Values are mean $\\pm$ stddev.`,
      'overall-comparison',
      headers,
      rows,
    ));
  }

  // ── Table 2: Per-Category Energy Comparison with Error Bars ─────────────

  if (activeFrameworks.length >= 2) {
    console.log('\n-- Table 2: Per-Category Energy (Wh) with Error Bars --\n');

    const headers2 = ['Category', ...activeFrameworks.map(([name]) => `${name} Energy (Wh)`)];
    const rows2: string[][] = [];

    for (const cat of CATEGORIES) {
      const row: string[] = [cat];
      for (const [, data] of activeFrameworks) {
        const catMs = data.measurements.filter(m => m.category === cat && m.task_success === 1);
        const byTask = new Map<string, number[]>();
        for (const m of catMs) {
          if (!byTask.has(m.task_id)) byTask.set(m.task_id, []);
          byTask.get(m.task_id)!.push(m.energy_wh);
        }
        const taskMeans = [...byTask.values()].map(v => mean(v));
        row.push(fmtPM(mean(taskMeans), stddev(taskMeans), 6));
      }
      rows2.push(row);
    }

    const colW2 = [18, ...activeFrameworks.map(() => 28)];
    console.log('  ' + headers2.map((h, i) => h.padEnd(colW2[i])).join(''));
    console.log('  ' + colW2.map(w => '-'.repeat(w)).join(''));
    for (const row of rows2) {
      console.log('  ' + row.map((c, i) => c.padEnd(colW2[i])).join(''));
    }

    latexTables.push(toLatexTable(
      'Per-category energy consumption (Wh) with error bars (mean $\\pm$ stddev, 3 runs per task).',
      'category-energy',
      headers2,
      rows2,
    ));
  }

  // ── Table 3: Ablation Study ─────────────────────────────────────────────

  const ablationResults: [string, ResultFile][] = [];
  for (const config of ABLATION_CONFIGS) {
    const data = results[`joule-${config}`];
    if (data) ablationResults.push([config, data]);
  }

  if (ablationResults.length >= 2) {
    console.log('\n-- Table 3: Ablation Study (Joule mechanism isolation) --\n');

    const headers3 = ['Config', 'Avg Energy (Wh)', 'Avg Tokens', 'Avg Quality', 'Success %'];
    const rows3: string[][] = [];

    for (const [config, data] of ablationResults) {
      const ms = data.measurements.filter(m => m.task_success === 1);
      const energies = ms.map(m => m.energy_wh);
      const tokens = ms.map(m => m.prompt_tokens + m.completion_tokens);
      const qualities = ms.filter(m => m.quality_score != null).map(m => m.quality_score!);
      const successRate = data.measurements.length > 0
        ? (ms.length / data.measurements.length * 100).toFixed(1)
        : '0.0';

      rows3.push([
        config,
        fmtPM(mean(energies), stddev(energies), 6),
        fmtPM(mean(tokens), stddev(tokens), 0),
        qualities.length > 0 ? fmtPM(mean(qualities), stddev(qualities), 2) : 'N/A',
        `${successRate}\\%`,
      ]);
    }

    const colW3 = [16, 28, 24, 20, 12];
    console.log('  ' + headers3.map((h, i) => h.padEnd(colW3[i])).join(''));
    console.log('  ' + colW3.map(w => '-'.repeat(w)).join(''));
    for (const row of rows3) {
      console.log('  ' + row.map((c, i) => c.padEnd(colW3[i])).join(''));
    }

    latexTables.push(toLatexTable(
      'Ablation study: contribution of each Joule mechanism. Each row disables one mechanism. Values are mean $\\pm$ stddev.',
      'ablation',
      headers3,
      rows3,
    ));
  }

  // ── Table 4: Pruning Metrics Per Category ───────────────────────────────

  if (joule) {
    const prunableMs = joule.measurements.filter(
      (m: Measurement) => m.pruning_total_results != null && m.pruning_total_results > 0
    );

    if (prunableMs.length > 0) {
      console.log('\n-- Table 4: Dependency Pruning Metrics Per Category --\n');

      const headers4 = ['Category', 'Tasks w/ Pruning', 'Avg Steps', 'Avg Pruned', 'Avg Pruning Rate', 'Avg Repaired Edges'];
      const rows4: string[][] = [];

      for (const cat of CATEGORIES) {
        const catMs = prunableMs.filter((m: Measurement) => m.category === cat);
        if (catMs.length === 0) {
          rows4.push([cat, '0', '-', '-', '-', '-']);
          continue;
        }

        rows4.push([
          cat,
          String(catMs.length),
          fmt(mean(catMs.map((m: Measurement) => m.pruning_total_results!)), 1),
          fmt(mean(catMs.map((m: Measurement) => m.pruning_pruned_count!)), 1),
          fmt(mean(catMs.map((m: Measurement) => m.pruning_rate!)) * 100, 1) + '\\%',
          fmt(mean(catMs.map((m: Measurement) => m.pruning_repaired_edges!)), 2),
        ]);
      }

      const colW4 = [18, 18, 12, 12, 18, 20];
      console.log('  ' + headers4.map((h, i) => h.padEnd(colW4[i])).join(''));
      console.log('  ' + colW4.map(w => '-'.repeat(w)).join(''));
      for (const row of rows4) {
        console.log('  ' + row.map((c, i) => c.padEnd(colW4[i])).join(''));
      }

      latexTables.push(toLatexTable(
        'Dependency pruning metrics per category. Pruning rate is the fraction of step results excluded from context. Repaired edges are undeclared dependencies caught by taint tracking.',
        'pruning-metrics',
        headers4,
        rows4,
      ));
    } else {
      console.log('\n  [INFO] No pruning data found in Joule results (pruning fields absent or all zero).');
    }
  }

  // ── Table 5: Pruning A/B Quality Comparison ─────────────────────────────

  const jouleFull = results['joule-full'];
  const jouleNoPruning = results['joule-no-pruning'];

  if (jouleFull && jouleNoPruning) {
    console.log('\n-- Table 5: Pruning A/B Quality Comparison --\n');

    const headers5 = ['Category', 'Full Quality', 'No-Pruning Quality', 'Delta', 'Full Energy', 'No-Pruning Energy', 'Energy Saved'];
    const rows5: string[][] = [];

    for (const cat of CATEGORIES) {
      const fullMs = jouleFull.measurements.filter((m: Measurement) => m.category === cat && m.task_success === 1);
      const npMs = jouleNoPruning.measurements.filter((m: Measurement) => m.category === cat && m.task_success === 1);

      const fullQ = fullMs.filter((m: Measurement) => m.quality_score != null).map((m: Measurement) => m.quality_score!);
      const npQ = npMs.filter((m: Measurement) => m.quality_score != null).map((m: Measurement) => m.quality_score!);
      const fullE = mean(fullMs.map((m: Measurement) => m.energy_wh));
      const npE = mean(npMs.map((m: Measurement) => m.energy_wh));

      const qDelta = fullQ.length > 0 && npQ.length > 0
        ? fmt(mean(fullQ) - mean(npQ), 2)
        : 'N/A';
      const eSaved = npE > 0 ? fmt((1 - fullE / npE) * 100, 1) + '\\%' : 'N/A';

      rows5.push([
        cat,
        fullQ.length > 0 ? fmt(mean(fullQ), 2) : 'N/A',
        npQ.length > 0 ? fmt(mean(npQ), 2) : 'N/A',
        qDelta,
        fmt(fullE, 6),
        fmt(npE, 6),
        eSaved,
      ]);
    }

    const colW5 = [18, 14, 18, 8, 14, 18, 14];
    console.log('  ' + headers5.map((h, i) => h.padEnd(colW5[i])).join(''));
    console.log('  ' + colW5.map(w => '-'.repeat(w)).join(''));
    for (const row of rows5) {
      console.log('  ' + row.map((c, i) => c.padEnd(colW5[i])).join(''));
    }

    latexTables.push(toLatexTable(
      'Pruning A/B comparison: output quality (1--5 LLM-as-judge) and energy with vs.\\ without dependency pruning. Delta $< 0$ means pruning reduced quality.',
      'pruning-ab',
      headers5,
      rows5,
    ));
  }

  // ── Save LaTeX ──────────────────────────────────────────────────────────

  if (latexTables.length > 0) {
    const latex = `% Auto-generated LaTeX tables for Joule paper\n% Generated: ${new Date().toISOString()}\n% Frameworks: ${loaded.map(([k]) => k).join(', ')}\n% Runs per task: 3\n\n` +
      latexTables.join('\n');
    const outPath = path.join(RESULTS_DIR, 'paper-tables.tex');
    fs.writeFileSync(outPath, latex);
    console.log(`\n  LaTeX tables saved to ${outPath}`);
  }

  console.log('\n' + '='.repeat(75));
  console.log('  ANALYSIS COMPLETE');
  console.log('='.repeat(75) + '\n');
}

main();
