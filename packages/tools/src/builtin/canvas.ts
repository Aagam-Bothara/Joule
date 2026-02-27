import { z } from 'zod';
import type { ToolDefinition } from '@joule/shared';
import { generateId } from '@joule/shared';

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_HTML = 100 * 1024;   // 100 KB
const MAX_CSS  = 50 * 1024;    // 50 KB
const MAX_JS   = 50 * 1024;    // 50 KB
const MAX_TITLE = 200;
const MAX_ROWS = 500;
const MAX_LABELS = 100;
const MAX_VERSIONS = 5;
const MAX_ARTIFACTS = 100;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const DEFAULT_COLORS = [
  '#4ecdc4', '#ff6b6b', '#50fa7b', '#bd93f9', '#f0c040',
  '#7b68ee', '#ff79c6', '#8be9fd', '#ffb86c', '#6272a4',
];

// Chart.js 4.4.7 pinned with SRI
const CHARTJS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
const CHARTJS_SRI = 'sha256-YEGZ8IVsYmMFGbTWqkhwwbx5GRBjVnMPx3kgcNkYPMo=';

// Prism.js 1.29.0 for syntax highlighting
const PRISM_CDN_CSS = 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css';
const PRISM_CDN_JS = 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js';

// ── Utilities ────────────────────────────────────────────────────────────────

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateSize(field: string, value: string, max: number): void {
  if (value.length > max) {
    throw new Error(`${field} exceeds max size of ${Math.round(max / 1024)}KB (got ${Math.round(value.length / 1024)}KB)`);
  }
}

// ── Artifact Store ───────────────────────────────────────────────────────────

export interface CanvasArtifact {
  id: string;
  title: string;
  html: string;       // full rendered document
  css: string;        // raw CSS input
  js: string;         // raw JS input
  rawHtml: string;    // raw HTML body input
  version: number;
  tags: string[];
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}

class ArtifactStore {
  private artifacts = new Map<string, CanvasArtifact>();
  private versions = new Map<string, CanvasArtifact[]>();

  get size(): number {
    return this.artifacts.size;
  }

  get(id: string): CanvasArtifact | undefined {
    return this.artifacts.get(id);
  }

  getVersion(id: string, version: number): CanvasArtifact | undefined {
    if (version === 0) return this.artifacts.get(id);
    const history = this.versions.get(id);
    if (!history) return undefined;
    // version 1 = most recent previous, stored at end of array
    return history[history.length - version];
  }

  list(limit = 50, offset = 0): { artifacts: CanvasArtifact[]; total: number } {
    const all = Array.from(this.artifacts.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return { artifacts: all.slice(offset, offset + limit), total: all.length };
  }

  set(artifact: CanvasArtifact): void {
    // Save previous version if updating
    const existing = this.artifacts.get(artifact.id);
    if (existing) {
      const history = this.versions.get(artifact.id) || [];
      history.push(existing);
      if (history.length > MAX_VERSIONS) history.shift();
      this.versions.set(artifact.id, history);
    }

    this.artifacts.set(artifact.id, artifact);
    this.cleanup();
  }

  delete(id: string): boolean {
    this.versions.delete(id);
    return this.artifacts.delete(id);
  }

  /** Remove expired artifacts and evict LRU if over capacity */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, art] of this.artifacts) {
      if (now - new Date(art.updatedAt).getTime() > MAX_AGE_MS) {
        this.artifacts.delete(id);
        this.versions.delete(id);
      }
    }

    // LRU eviction if over max
    if (this.artifacts.size > MAX_ARTIFACTS) {
      const sorted = Array.from(this.artifacts.entries()).sort(
        (a, b) => new Date(a[1].updatedAt).getTime() - new Date(b[1].updatedAt).getTime(),
      );
      const toEvict = sorted.slice(0, this.artifacts.size - MAX_ARTIFACTS);
      for (const [id] of toEvict) {
        this.artifacts.delete(id);
        this.versions.delete(id);
      }
    }
  }

  /** For testing — reset store */
  _reset(): void {
    this.artifacts.clear();
    this.versions.clear();
  }
}

const store = new ArtifactStore();

// Public accessors for server routes
export function getArtifact(id: string): CanvasArtifact | undefined {
  return store.get(id);
}

export function getArtifactVersion(id: string, version: number): CanvasArtifact | undefined {
  return store.getVersion(id, version);
}

export function listArtifacts(limit?: number, offset?: number): { artifacts: CanvasArtifact[]; total: number } {
  return store.list(limit, offset);
}

/** Exposed for tests only */
export function _getStore(): ArtifactStore {
  return store;
}

// ── Document Builder ─────────────────────────────────────────────────────────

function buildDocument(html: string, css: string, js: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f17; color: #e0e0e0; padding: 16px; }
a { color: #4ecdc4; }
${css}
</style>
</head>
<body>
${html}
<script>
window.onerror = function(msg, src, line) {
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:12px 16px;background:#ff6b6b;color:#fff;font:13px monospace;z-index:9999';
  d.textContent = 'Error: ' + msg + (line ? ' (line ' + line + ')' : '');
  document.body.appendChild(d);
};
${js}
</script>
</body>
</html>`;
}

// ── canvas_render ────────────────────────────────────────────────────────────

export const canvasRenderTool: ToolDefinition = {
  name: 'canvas_render',
  description:
    'Render interactive HTML content in the dashboard canvas. ' +
    'Provide html, optional css/js, and a title. ' +
    'The output appears as a live visual panel the user can interact with. ' +
    'Use this when the user asks to SHOW, DISPLAY, VISUALIZE, or CREATE a UI.',
  inputSchema: z.object({
    html: z.string().max(MAX_HTML).describe('HTML body content to render'),
    css: z.string().max(MAX_CSS).optional().default('').describe('CSS styles'),
    js: z.string().max(MAX_JS).optional().default('').describe('JavaScript code'),
    title: z.string().max(MAX_TITLE).optional().default('Canvas').describe('Title for the canvas'),
    artifactId: z.string().optional().describe('Existing artifact ID to update (omit to create new)'),
    tags: z.array(z.string()).optional().default([]).describe('Tags for categorization'),
  }),
  outputSchema: z.object({
    artifactId: z.string(),
    title: z.string(),
    version: z.number(),
    updated: z.boolean(),
    energyMWh: z.number(),
  }),
  tags: ['canvas', 'visual'],

  async execute(input) {
    validateSize('html', input.html, MAX_HTML);
    if (input.css) validateSize('css', input.css, MAX_CSS);
    if (input.js) validateSize('js', input.js, MAX_JS);

    const now = new Date().toISOString();
    const existing = input.artifactId ? store.get(input.artifactId) : undefined;
    const isUpdate = !!existing;
    const id = isUpdate ? input.artifactId! : generateId('canvas');

    const fullHtml = buildDocument(input.html, input.css || '', input.js || '', input.title || 'Canvas');
    const version = isUpdate ? existing!.version + 1 : 0;

    const artifact: CanvasArtifact = {
      id,
      title: input.title || 'Canvas',
      html: fullHtml,
      rawHtml: input.html,
      css: input.css || '',
      js: input.js || '',
      version,
      tags: input.tags || [],
      createdAt: isUpdate ? existing!.createdAt : now,
      updatedAt: now,
    };

    store.set(artifact);

    return {
      artifactId: id,
      title: artifact.title,
      version,
      updated: isUpdate,
      energyMWh: 0.001,
    };
  },
};

// ── canvas_update ────────────────────────────────────────────────────────────

export const canvasUpdateTool: ToolDefinition = {
  name: 'canvas_update',
  description:
    'Partially update an existing canvas artifact. ' +
    'Provide only the fields to change (html, css, js, or title). Unchanged fields are preserved. ' +
    'More efficient than canvas_render when modifying only part of an artifact.',
  inputSchema: z.object({
    artifactId: z.string().describe('ID of the artifact to update'),
    html: z.string().max(MAX_HTML).optional().describe('New HTML body (omit to keep current)'),
    css: z.string().max(MAX_CSS).optional().describe('New CSS (omit to keep current)'),
    js: z.string().max(MAX_JS).optional().describe('New JS (omit to keep current)'),
    title: z.string().max(MAX_TITLE).optional().describe('New title (omit to keep current)'),
  }),
  outputSchema: z.object({
    artifactId: z.string(),
    version: z.number(),
    energyMWh: z.number(),
  }),
  tags: ['canvas', 'visual'],

  async execute(input) {
    const existing = store.get(input.artifactId);
    if (!existing) {
      throw new Error(`Artifact "${input.artifactId}" not found. Use canvas_render to create a new artifact.`);
    }

    if (input.html) validateSize('html', input.html, MAX_HTML);
    if (input.css) validateSize('css', input.css, MAX_CSS);
    if (input.js) validateSize('js', input.js, MAX_JS);

    const mergedHtml = input.html ?? existing.rawHtml;
    const mergedCss = input.css ?? existing.css;
    const mergedJs = input.js ?? existing.js;
    const mergedTitle = input.title ?? existing.title;
    const newVersion = existing.version + 1;

    const fullHtml = buildDocument(mergedHtml, mergedCss, mergedJs, mergedTitle);

    const updated: CanvasArtifact = {
      ...existing,
      title: mergedTitle,
      html: fullHtml,
      rawHtml: mergedHtml,
      css: mergedCss,
      js: mergedJs,
      version: newVersion,
      updatedAt: new Date().toISOString(),
    };

    store.set(updated);

    return {
      artifactId: input.artifactId,
      version: newVersion,
      energyMWh: 0.001,
    };
  },
};

// ── canvas_chart ─────────────────────────────────────────────────────────────

const datasetSchema = z.object({
  label: z.string().describe('Dataset label'),
  values: z.array(z.number()).describe('Data values'),
  color: z.string().optional().describe('Line/bar color'),
});

export const canvasChartTool: ToolDefinition = {
  name: 'canvas_chart',
  description:
    'Render a chart (bar, line, pie, doughnut) in the dashboard canvas. ' +
    'Provide labels + values for a single dataset, or use datasets[] for multi-series charts.',
  inputSchema: z.object({
    type: z.enum(['bar', 'line', 'pie', 'doughnut']).describe('Chart type'),
    title: z.string().max(MAX_TITLE).optional().default('Chart').describe('Chart title'),
    labels: z.array(z.string()).max(MAX_LABELS).describe('Data labels'),
    values: z.array(z.number()).optional().describe('Data values (single dataset mode)'),
    datasets: z.array(datasetSchema).optional().describe('Multiple datasets (multi-series mode)'),
    colors: z.array(z.string()).optional().describe('Custom colors'),
    legendPosition: z.enum(['top', 'bottom', 'left', 'right']).optional().default('top').describe('Legend position'),
  }),
  outputSchema: z.object({
    artifactId: z.string(),
    title: z.string(),
    energyMWh: z.number(),
  }),
  tags: ['canvas', 'visual'],

  async execute(input) {
    if (!input.values && !input.datasets) {
      throw new Error('Provide either "values" (single dataset) or "datasets" (multi-series).');
    }
    if (input.labels.length > MAX_LABELS) {
      throw new Error(`Labels exceed max of ${MAX_LABELS}`);
    }

    const colors = input.colors ?? DEFAULT_COLORS;

    let datasets: any[];
    if (input.datasets) {
      datasets = input.datasets.map((ds: z.infer<typeof datasetSchema>, i: number) => ({
        label: ds.label,
        data: ds.values,
        backgroundColor: ds.color || colors[i % colors.length],
        borderColor: ds.color || colors[i % colors.length],
        borderWidth: input.type === 'line' ? 2 : 1,
        fill: false,
        tension: 0.3,
      }));
    } else {
      datasets = [{
        label: input.title,
        data: input.values,
        backgroundColor: colors.slice(0, input.labels.length),
        borderColor: input.type === 'line' ? colors[0] : colors.slice(0, input.labels.length),
        borderWidth: input.type === 'line' ? 2 : 1,
        fill: input.type === 'line',
        tension: 0.3,
      }];
    }

    const chartData = JSON.stringify({ labels: input.labels, datasets });
    const hasAxes = ['bar', 'line'].includes(input.type);

    const chartOptions = JSON.stringify({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: input.legendPosition, labels: { color: '#e0e0e0' } },
        title: { display: true, text: input.title, color: '#e0e0e0', font: { size: 16 } },
      },
      scales: hasAxes ? {
        x: { ticks: { color: '#aaa' }, grid: { color: '#333' } },
        y: { ticks: { color: '#aaa' }, grid: { color: '#333' } },
      } : undefined,
    });

    const html = `<div style="width:100%;height:400px"><canvas id="chart"></canvas></div>`;
    const js = `
var s=document.createElement('script');
s.src='${CHARTJS_CDN}';
s.integrity='${CHARTJS_SRI}';
s.crossOrigin='anonymous';
s.onload=function(){
  new Chart(document.getElementById('chart'),{
    type:'${input.type}',
    data:${chartData},
    options:${chartOptions}
  });
};
s.onerror=function(){document.body.innerHTML='<p style="color:#ff6b6b">Failed to load Chart.js</p>'};
document.head.appendChild(s);
`;

    const result = await canvasRenderTool.execute({
      html,
      css: '',
      js,
      title: input.title,
    });

    return {
      artifactId: result.artifactId,
      title: input.title || 'Chart',
      energyMWh: 0.001,
    };
  },
};

// ── canvas_table ─────────────────────────────────────────────────────────────

export const canvasTableTool: ToolDefinition = {
  name: 'canvas_table',
  description:
    'Render a styled, optionally sortable and searchable table in the dashboard canvas. ' +
    'Provide headers and rows as arrays. Cells are auto-escaped for safety.',
  inputSchema: z.object({
    title: z.string().max(MAX_TITLE).optional().default('Table').describe('Table title'),
    headers: z.array(z.string()).describe('Column headers'),
    rows: z.array(z.array(z.string())).describe('Table rows (array of arrays)'),
    sortable: z.boolean().optional().default(false).describe('Enable column sorting'),
    searchable: z.boolean().optional().default(false).describe('Add search/filter input'),
    alignments: z.array(z.enum(['left', 'center', 'right'])).optional().describe('Column text alignments'),
    maxHeight: z.string().optional().default('600px').describe('Max table height (CSS value)'),
  }),
  outputSchema: z.object({
    artifactId: z.string(),
    title: z.string(),
    rowCount: z.number(),
    truncated: z.boolean(),
    energyMWh: z.number(),
  }),
  tags: ['canvas', 'visual'],

  async execute(input) {
    let rows = input.rows;
    let truncated = false;
    if (rows.length > MAX_ROWS) {
      rows = rows.slice(0, MAX_ROWS);
      truncated = true;
    }

    const getAlign = (i: number): string => {
      if (input.alignments && input.alignments[i]) return `text-align:${input.alignments[i]}`;
      return 'text-align:left';
    };

    const thCells = input.headers.map((h: string, i: number) => {
      const align = getAlign(i);
      if (input.sortable) {
        return `<th onclick="sortTable(${i})" style="cursor:pointer;${align}">${escapeHtml(h)} ↕</th>`;
      }
      return `<th style="${align}">${escapeHtml(h)}</th>`;
    }).join('');

    const tbodyRows = rows.map((row: string[]) =>
      `<tr>${row.map((cell: string, i: number) =>
        `<td style="${getAlign(i)}">${escapeHtml(cell)}</td>`
      ).join('')}</tr>`,
    ).join('\n');

    const searchHtml = input.searchable
      ? `<input id="table-search" type="text" placeholder="Filter rows..." style="width:100%;padding:8px 12px;margin-bottom:12px;background:#1a1a2e;border:1px solid #333;border-radius:4px;color:#e0e0e0;font-size:13px">`
      : '';

    const truncMsg = truncated
      ? `<div style="padding:8px;color:#ffb86c;font-size:12px;text-align:center">Showing ${MAX_ROWS} of ${input.rows.length} rows</div>`
      : '';

    const html = `
<h2 style="margin-bottom:12px;color:#4ecdc4">${escapeHtml(input.title || 'Table')}</h2>
${searchHtml}
<div style="max-height:${input.maxHeight};overflow:auto">
<table id="data-table">
<thead><tr>${thCells}</tr></thead>
<tbody>${tbodyRows}</tbody>
</table>
</div>
${truncMsg}`;

    const css = `
table { width:100%; border-collapse:collapse; }
th, td { padding:10px 14px; border-bottom:1px solid #2a2a3e; }
th { background:#1a1a2e; color:#4ecdc4; font-weight:600; position:sticky; top:0; z-index:1; }
tr:hover { background:#1a1a2e; }
`;

    let js = '';
    if (input.sortable) {
      js += `
var sortDir={};
function sortTable(col){
  var tbody=document.querySelector('#data-table tbody');
  var rows=Array.from(tbody.querySelectorAll('tr'));
  sortDir[col]=!sortDir[col];
  rows.sort(function(a,b){
    var aVal=a.children[col].textContent;
    var bVal=b.children[col].textContent;
    var aNum=parseFloat(aVal),bNum=parseFloat(bVal);
    if(!isNaN(aNum)&&!isNaN(bNum))return sortDir[col]?aNum-bNum:bNum-aNum;
    return sortDir[col]?aVal.localeCompare(bVal):bVal.localeCompare(aVal);
  });
  rows.forEach(function(r){tbody.appendChild(r)});
}`;
    }

    if (input.searchable) {
      js += `
document.getElementById('table-search').addEventListener('input',function(e){
  var q=e.target.value.toLowerCase();
  var rows=document.querySelectorAll('#data-table tbody tr');
  rows.forEach(function(r){
    r.style.display=r.textContent.toLowerCase().includes(q)?'':'none';
  });
});`;
    }

    const result = await canvasRenderTool.execute({
      html,
      css,
      js,
      title: input.title,
    });

    return {
      artifactId: result.artifactId,
      title: input.title || 'Table',
      rowCount: rows.length,
      truncated,
      energyMWh: 0.001,
    };
  },
};

// ── canvas_code ──────────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = [
  'javascript', 'typescript', 'python', 'json', 'html', 'css',
  'sql', 'bash', 'yaml', 'text', 'go', 'rust', 'java', 'csharp',
] as const;

export const canvasCodeTool: ToolDefinition = {
  name: 'canvas_code',
  description:
    'Display syntax-highlighted code in the dashboard canvas. ' +
    'Use this for code snippets, config files, or any structured text that benefits from highlighting.',
  inputSchema: z.object({
    code: z.string().max(MAX_HTML).describe('The source code to display'),
    language: z.enum(SUPPORTED_LANGUAGES).describe('Programming language for highlighting'),
    title: z.string().max(MAX_TITLE).optional().default('Code').describe('Title for the code panel'),
    lineNumbers: z.boolean().optional().default(true).describe('Show line numbers'),
    highlightLines: z.array(z.number()).optional().describe('Line numbers to highlight (1-based)'),
  }),
  outputSchema: z.object({
    artifactId: z.string(),
    title: z.string(),
    lineCount: z.number(),
    energyMWh: z.number(),
  }),
  tags: ['canvas', 'visual', 'code'],

  async execute(input) {
    const lines = input.code.split('\n');
    const highlightSet = new Set(input.highlightLines || []);
    const showLineNumbers = input.lineNumbers !== false; // default true

    // Map language names to Prism class names
    const prismLang = input.language === 'text' ? 'plaintext'
      : input.language === 'bash' ? 'shell'
      : input.language === 'csharp' ? 'clike'
      : input.language;

    const codeLines = lines.map((line: string, i: number) => {
      const lineNum = i + 1;
      const isHighlighted = highlightSet.has(lineNum);
      const hlClass = isHighlighted ? ' class="hl"' : '';
      const numSpan = showLineNumbers
        ? `<span class="ln">${lineNum}</span>`
        : '';
      return `<div${hlClass}>${numSpan}${escapeHtml(line) || ' '}</div>`;
    }).join('\n');

    const html = `
<div class="code-panel">
  <div class="code-header">${escapeHtml(input.title || 'Code')} <span class="lang-badge">${escapeHtml(input.language)}</span></div>
  <pre class="code-body"><code class="language-${prismLang}">${codeLines}</code></pre>
</div>`;

    const css = `
.code-panel { border:1px solid #333; border-radius:8px; overflow:hidden; }
.code-header { padding:8px 14px; background:#1a1a2e; color:#4ecdc4; font-size:13px; font-weight:600; display:flex; justify-content:space-between; align-items:center; }
.lang-badge { background:#333; color:#aaa; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:400; }
.code-body { margin:0; padding:16px; overflow-x:auto; font-size:13px; line-height:1.6; background:#1e1e2e; }
.code-body code { font-family:'Fira Code',Consolas,'Courier New',monospace; }
.code-body div { white-space:pre; }
.code-body .hl { background:rgba(255,184,108,0.15); margin:0 -16px; padding:0 16px; }
.ln { display:inline-block; width:3.5em; text-align:right; padding-right:1em; color:#555; user-select:none; }
`;

    // Load Prism.js for syntax highlighting (falls back to plain text if CDN unavailable)
    const js = `
(function(){
  var link=document.createElement('link');
  link.rel='stylesheet';link.href='${PRISM_CDN_CSS}';
  document.head.appendChild(link);
  var s=document.createElement('script');
  s.src='${PRISM_CDN_JS}';
  s.onload=function(){if(window.Prism)Prism.highlightAll()};
  document.head.appendChild(s);
})();
`;

    const result = await canvasRenderTool.execute({
      html,
      css,
      js,
      title: input.title,
    });

    return {
      artifactId: result.artifactId,
      title: input.title || 'Code',
      lineCount: lines.length,
      energyMWh: 0.001,
    };
  },
};
