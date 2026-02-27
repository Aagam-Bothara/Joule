import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  canvasRenderTool,
  canvasChartTool,
  canvasTableTool,
  canvasUpdateTool,
  canvasCodeTool,
  getArtifact,
  getArtifactVersion,
  listArtifacts,
  escapeHtml,
  _getStore,
} from '../src/builtin/canvas.js';

describe('Canvas Tools v2', () => {
  beforeEach(() => {
    _getStore()._reset();
  });

  // ─── escapeHtml ───

  describe('escapeHtml', () => {
    it('escapes HTML entities', () => {
      expect(escapeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
      );
    });

    it('escapes ampersands', () => {
      expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('escapes single quotes', () => {
      expect(escapeHtml("it's")).toBe('it&#39;s');
    });

    it('returns empty string unchanged', () => {
      expect(escapeHtml('')).toBe('');
    });
  });

  // ─── canvas_render ───

  describe('canvas_render', () => {
    it('has correct name and tags', () => {
      expect(canvasRenderTool.name).toBe('canvas_render');
      expect(canvasRenderTool.tags).toContain('canvas');
      expect(canvasRenderTool.tags).toContain('visual');
    });

    it('creates a new artifact with version 0', async () => {
      const result = await canvasRenderTool.execute({
        html: '<h1>Hello</h1>',
        title: 'Test',
      });

      expect(result.artifactId).toBeTruthy();
      expect(result.title).toBe('Test');
      expect(result.version).toBe(0);
      expect(result.updated).toBe(false);
      expect(result.energyMWh).toBeGreaterThan(0);
    });

    it('stores artifact retrievable via getArtifact', async () => {
      const result = await canvasRenderTool.execute({
        html: '<p>Stored</p>',
        title: 'Stored Canvas',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact).toBeDefined();
      expect(artifact!.title).toBe('Stored Canvas');
      expect(artifact!.html).toContain('<p>Stored</p>');
      expect(artifact!.html).toContain('<!DOCTYPE html>');
      expect(artifact!.rawHtml).toBe('<p>Stored</p>');
    });

    it('escapes title in HTML document', async () => {
      const result = await canvasRenderTool.execute({
        html: '<p>test</p>',
        title: '<script>alert(1)</script>',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('&lt;script&gt;');
      expect(artifact!.html).not.toContain('<title><script>');
    });

    it('builds document with css and js', async () => {
      const result = await canvasRenderTool.execute({
        html: '<div id="app"></div>',
        css: '.app { color: red; }',
        js: 'console.log("hi")',
        title: 'Full Doc',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('.app { color: red; }');
      expect(artifact!.html).toContain('console.log("hi")');
    });

    it('includes error boundary in document', async () => {
      const result = await canvasRenderTool.execute({
        html: '<p>err</p>',
        title: 'ErrTest',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('window.onerror');
    });

    it('updates existing artifact with version increment', async () => {
      const first = await canvasRenderTool.execute({
        html: '<p>V1</p>',
        title: 'Update Test',
      });

      const second = await canvasRenderTool.execute({
        html: '<p>V2</p>',
        title: 'Update Test',
        artifactId: first.artifactId,
      });

      expect(second.artifactId).toBe(first.artifactId);
      expect(second.updated).toBe(true);
      expect(second.version).toBe(1);

      const artifact = getArtifact(first.artifactId);
      expect(artifact!.html).toContain('<p>V2</p>');
    });

    it('creates new artifact if artifactId does not exist', async () => {
      const result = await canvasRenderTool.execute({
        html: '<p>New</p>',
        title: 'New Canvas',
        artifactId: 'nonexistent-id',
      });

      expect(result.artifactId).not.toBe('nonexistent-id');
      expect(result.updated).toBe(false);
      expect(result.version).toBe(0);
    });

    it('rejects oversized HTML', async () => {
      const bigHtml = 'x'.repeat(100 * 1024 + 1);
      await expect(
        canvasRenderTool.execute({ html: bigHtml, title: 'Big' }),
      ).rejects.toThrow('html exceeds max size');
    });

    it('rejects oversized CSS', async () => {
      const bigCss = 'x'.repeat(50 * 1024 + 1);
      await expect(
        canvasRenderTool.execute({ html: '<p>ok</p>', css: bigCss }),
      ).rejects.toThrow('css exceeds max size');
    });

    it('rejects oversized JS', async () => {
      const bigJs = 'x'.repeat(50 * 1024 + 1);
      await expect(
        canvasRenderTool.execute({ html: '<p>ok</p>', js: bigJs }),
      ).rejects.toThrow('js exceeds max size');
    });

    it('supports tags for categorization', async () => {
      const result = await canvasRenderTool.execute({
        html: '<p>tagged</p>',
        title: 'Tagged',
        tags: ['dashboard', 'analytics'],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.tags).toEqual(['dashboard', 'analytics']);
    });
  });

  // ─── Version history ───

  describe('version history', () => {
    it('stores previous version on update', async () => {
      const r1 = await canvasRenderTool.execute({ html: '<p>V0</p>', title: 'Versioned' });
      await canvasRenderTool.execute({ html: '<p>V1</p>', title: 'Versioned', artifactId: r1.artifactId });

      const v0 = getArtifactVersion(r1.artifactId, 1); // version 1 = prev
      expect(v0).toBeDefined();
      expect(v0!.html).toContain('<p>V0</p>');
    });

    it('current version is accessible at version 0', async () => {
      const r1 = await canvasRenderTool.execute({ html: '<p>Current</p>', title: 'VC' });
      const current = getArtifactVersion(r1.artifactId, 0);
      expect(current).toBeDefined();
      expect(current!.html).toContain('<p>Current</p>');
    });

    it('stores max 5 previous versions', async () => {
      const r1 = await canvasRenderTool.execute({ html: '<p>V0</p>', title: 'MaxVer' });
      for (let i = 1; i <= 7; i++) {
        await canvasRenderTool.execute({ html: `<p>V${i}</p>`, title: 'MaxVer', artifactId: r1.artifactId });
      }

      // Version 5 should exist, version 6 should not (only 5 kept)
      expect(getArtifactVersion(r1.artifactId, 5)).toBeDefined();
      expect(getArtifactVersion(r1.artifactId, 6)).toBeUndefined();
    });

    it('returns undefined for nonexistent version', () => {
      expect(getArtifactVersion('no-such-id', 0)).toBeUndefined();
      expect(getArtifactVersion('no-such-id', 1)).toBeUndefined();
    });
  });

  // ─── Artifact store lifecycle ───

  describe('artifact store', () => {
    it('listArtifacts returns paginated results', async () => {
      for (let i = 0; i < 5; i++) {
        await canvasRenderTool.execute({ html: `<p>${i}</p>`, title: `Art ${i}` });
      }

      const { artifacts, total } = listArtifacts(2, 0);
      expect(artifacts).toHaveLength(2);
      expect(total).toBe(5);

      const page2 = listArtifacts(2, 2);
      expect(page2.artifacts).toHaveLength(2);
    });

    it('evicts oldest artifacts when over 100', async () => {
      // Create 101 artifacts
      for (let i = 0; i < 101; i++) {
        await canvasRenderTool.execute({ html: `<p>${i}</p>`, title: `Evict ${i}` });
      }

      expect(_getStore().size).toBeLessThanOrEqual(100);
    });

    it('store.size reflects count correctly', async () => {
      expect(_getStore().size).toBe(0);
      await canvasRenderTool.execute({ html: '<p>1</p>', title: 'Size' });
      expect(_getStore().size).toBe(1);
    });
  });

  // ─── canvas_update ───

  describe('canvas_update', () => {
    it('has correct name and tags', () => {
      expect(canvasUpdateTool.name).toBe('canvas_update');
      expect(canvasUpdateTool.tags).toContain('canvas');
    });

    it('partially updates CSS only', async () => {
      const r = await canvasRenderTool.execute({
        html: '<p>Original</p>',
        css: 'p { color: red; }',
        js: 'console.log(1)',
        title: 'Partial',
      });

      const result = await canvasUpdateTool.execute({
        artifactId: r.artifactId,
        css: 'p { color: blue; }',
      });

      expect(result.version).toBe(1);
      const artifact = getArtifact(r.artifactId);
      expect(artifact!.css).toBe('p { color: blue; }');
      expect(artifact!.rawHtml).toBe('<p>Original</p>');
      expect(artifact!.js).toBe('console.log(1)');
    });

    it('partially updates title only', async () => {
      const r = await canvasRenderTool.execute({ html: '<p>X</p>', title: 'Old Title' });

      await canvasUpdateTool.execute({
        artifactId: r.artifactId,
        title: 'New Title',
      });

      const artifact = getArtifact(r.artifactId);
      expect(artifact!.title).toBe('New Title');
    });

    it('throws for nonexistent artifact', async () => {
      await expect(
        canvasUpdateTool.execute({ artifactId: 'fake-id', html: '<p>X</p>' }),
      ).rejects.toThrow('not found');
    });

    it('preserves version history on update', async () => {
      const r = await canvasRenderTool.execute({ html: '<p>V0</p>', title: 'PU' });
      await canvasUpdateTool.execute({ artifactId: r.artifactId, html: '<p>V1</p>' });

      const prev = getArtifactVersion(r.artifactId, 1);
      expect(prev).toBeDefined();
      expect(prev!.rawHtml).toBe('<p>V0</p>');
    });
  });

  // ─── canvas_chart ───

  describe('canvas_chart', () => {
    it('has correct name and tags', () => {
      expect(canvasChartTool.name).toBe('canvas_chart');
      expect(canvasChartTool.tags).toContain('canvas');
    });

    it('creates a single-dataset bar chart', async () => {
      const result = await canvasChartTool.execute({
        type: 'bar',
        title: 'Sales',
        labels: ['Jan', 'Feb'],
        values: [100, 200],
      });

      expect(result.artifactId).toBeTruthy();
      expect(result.title).toBe('Sales');

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('chart.js');
      expect(artifact!.html).toContain('integrity');
    });

    it('creates multi-dataset chart', async () => {
      const result = await canvasChartTool.execute({
        type: 'line',
        title: 'Comparison',
        labels: ['Q1', 'Q2'],
        datasets: [
          { label: 'Sales', values: [100, 150] },
          { label: 'Costs', values: [80, 90] },
        ],
      });

      expect(result.artifactId).toBeTruthy();
      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('Sales');
      expect(artifact!.html).toContain('Costs');
    });

    it('accepts custom colors', async () => {
      const result = await canvasChartTool.execute({
        type: 'pie',
        title: 'Colors',
        labels: ['A', 'B'],
        values: [50, 50],
        colors: ['#ff0000', '#00ff00'],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('#ff0000');
    });

    it('throws when neither values nor datasets provided', async () => {
      await expect(
        canvasChartTool.execute({
          type: 'bar',
          title: 'Empty',
          labels: ['A'],
        }),
      ).rejects.toThrow('values');
    });

    it('includes SRI hash for Chart.js', async () => {
      const result = await canvasChartTool.execute({
        type: 'doughnut',
        title: 'SRI Test',
        labels: ['X'],
        values: [1],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('sha256-');
      expect(artifact!.html).toContain('crossOrigin');
    });

    it('includes CDN error fallback', async () => {
      const result = await canvasChartTool.execute({
        type: 'bar',
        title: 'Fallback',
        labels: ['X'],
        values: [1],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('onerror');
      expect(artifact!.html).toContain('Failed to load Chart.js');
    });
  });

  // ─── canvas_table ───

  describe('canvas_table', () => {
    it('has correct name and tags', () => {
      expect(canvasTableTool.name).toBe('canvas_table');
      expect(canvasTableTool.tags).toContain('canvas');
    });

    it('creates a basic table', async () => {
      const result = await canvasTableTool.execute({
        title: 'Users',
        headers: ['Name', 'Age'],
        rows: [['Alice', '30'], ['Bob', '25']],
      });

      expect(result.artifactId).toBeTruthy();
      expect(result.rowCount).toBe(2);
      expect(result.truncated).toBe(false);

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('Alice');
      expect(artifact!.html).toContain('Bob');
    });

    it('escapes cell content to prevent XSS', async () => {
      const result = await canvasTableTool.execute({
        title: 'XSS',
        headers: ['Data'],
        rows: [['<img src=x onerror=alert(1)>']],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('&lt;img');
      expect(artifact!.html).not.toContain('<img src=x');
    });

    it('escapes header content', async () => {
      const result = await canvasTableTool.execute({
        title: 'Headers',
        headers: ['<b>Bold</b>'],
        rows: [['x']],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
    });

    it('creates a sortable table', async () => {
      const result = await canvasTableTool.execute({
        title: 'Sortable',
        headers: ['Item', 'Count'],
        rows: [['Widget', '5']],
        sortable: true,
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('sortTable');
      expect(artifact!.html).toContain('cursor:pointer');
    });

    it('creates a searchable table', async () => {
      const result = await canvasTableTool.execute({
        title: 'Searchable',
        headers: ['Name'],
        rows: [['Alice'], ['Bob']],
        searchable: true,
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('table-search');
      expect(artifact!.html).toContain('Filter rows');
    });

    it('truncates rows beyond MAX_ROWS', async () => {
      const manyRows = Array.from({ length: 600 }, (_, i) => [`Row ${i}`]);
      const result = await canvasTableTool.execute({
        title: 'Large',
        headers: ['Data'],
        rows: manyRows,
      });

      expect(result.rowCount).toBe(500);
      expect(result.truncated).toBe(true);
      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('Showing 500 of 600 rows');
    });

    it('supports column alignments', async () => {
      const result = await canvasTableTool.execute({
        title: 'Aligned',
        headers: ['Name', 'Amount'],
        rows: [['Alice', '100']],
        alignments: ['left', 'right'],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('text-align:right');
    });

    it('has sticky headers', async () => {
      const result = await canvasTableTool.execute({
        title: 'Sticky',
        headers: ['A'],
        rows: [['1']],
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('position:sticky');
    });
  });

  // ─── canvas_code ───

  describe('canvas_code', () => {
    it('has correct name and tags', () => {
      expect(canvasCodeTool.name).toBe('canvas_code');
      expect(canvasCodeTool.tags).toContain('canvas');
      expect(canvasCodeTool.tags).toContain('code');
    });

    it('creates a code display artifact', async () => {
      const result = await canvasCodeTool.execute({
        code: 'const x = 42;\nconsole.log(x);',
        language: 'javascript',
        title: 'Sample Code',
      });

      expect(result.artifactId).toBeTruthy();
      expect(result.title).toBe('Sample Code');
      expect(result.lineCount).toBe(2);

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('language-javascript');
      expect(artifact!.html).toContain('prism');
    });

    it('escapes code content', async () => {
      const result = await canvasCodeTool.execute({
        code: '<div class="test">foo</div>',
        language: 'html',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('&lt;div');
    });

    it('shows line numbers by default', async () => {
      const result = await canvasCodeTool.execute({
        code: 'line1\nline2\nline3',
        language: 'python',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('class="ln"');
      expect(artifact!.html).toContain('>1<');
      expect(artifact!.html).toContain('>3<');
    });

    it('hides line numbers when disabled', async () => {
      const result = await canvasCodeTool.execute({
        code: 'no lines',
        language: 'text',
        lineNumbers: false,
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).not.toContain('class="ln"');
    });

    it('highlights specified lines', async () => {
      const result = await canvasCodeTool.execute({
        code: 'a\nb\nc\nd',
        language: 'javascript',
        highlightLines: [2, 4],
      });

      const artifact = getArtifact(result.artifactId);
      // Lines 2 and 4 should have class="hl"
      const lines = artifact!.html.match(/class="hl"/g);
      expect(lines).toHaveLength(2);
    });

    it('shows language badge', async () => {
      const result = await canvasCodeTool.execute({
        code: 'SELECT 1',
        language: 'sql',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('lang-badge');
      expect(artifact!.html).toContain('sql');
    });

    it('maps bash to shell for Prism', async () => {
      const result = await canvasCodeTool.execute({
        code: 'echo hello',
        language: 'bash',
      });

      const artifact = getArtifact(result.artifactId);
      expect(artifact!.html).toContain('language-shell');
    });
  });
});
