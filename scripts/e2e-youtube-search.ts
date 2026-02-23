/**
 * Joule E2E Test: Chrome → YouTube Song Search
 *
 * This script exercises the full Joule pipeline against a real browser:
 *   Engine → Planner → TaskExecutor → browser tools (CDP → Chrome)
 *
 * It connects to your real Chrome profile (preserving login sessions),
 * opens YouTube, and searches for a song.
 *
 * Prerequisites:
 *   - Chrome installed
 *   - Playwright installed (pnpm add playwright)
 *   - A provider configured in joule.config.yaml (Anthropic, Google, etc.)
 *   - Build first: pnpm -r build
 *
 * Usage:
 *   cd packages/cli && pnpm exec tsx ../../scripts/e2e-youtube-search.ts
 *   cd packages/cli && pnpm exec tsx ../../scripts/e2e-youtube-search.ts "Bohemian Rhapsody Queen"
 */

import { Joule } from '@joule/core';
import { generateId } from '@joule/shared';
import {
  AnthropicProvider,
  GoogleProvider,
  OpenAIProvider,
  OllamaProvider,
} from '@joule/models';
import {
  browserNavigateTool,
  browserScreenshotTool,
  browserClickTool,
  browserWaitAndClickTool,
  browserTypeTool,
  browserExtractTool,
  browserObserveTool,
  browserEvaluateTool,
  configureBrowser,
  closeBrowser,
} from '@joule/tools';

const song = process.argv[2] || 'Never Gonna Give You Up Rick Astley';

async function main() {
  // Ensure we run from the project root so joule.config.yaml is found
  const scriptDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const projectRoot = scriptDir.replace(/[/\\]scripts[/\\]?$/, '');
  process.chdir(projectRoot);

  console.log('=== Joule E2E: YouTube Song Search ===');
  console.log(`Song: "${song}"`);
  console.log(`Working dir: ${process.cwd()}`);
  console.log('');

  // 1. Initialize Joule
  const joule = new Joule();
  await joule.initialize();

  // 2. Register providers from config
  const config = joule.config.getAll();

  if (config.providers.anthropic?.enabled && config.providers.anthropic.apiKey) {
    joule.providers.register(new AnthropicProvider({
      apiKey: config.providers.anthropic.apiKey,
      slmModel: config.providers.anthropic.models.slm,
      llmModel: config.providers.anthropic.models.llm,
    }));
  }

  if (config.providers.google?.enabled && config.providers.google.apiKey) {
    joule.providers.register(new GoogleProvider({
      apiKey: config.providers.google.apiKey,
      slmModel: config.providers.google.models.slm,
      llmModel: config.providers.google.models.llm,
    }));
  }

  if (config.providers.openai?.enabled && config.providers.openai.apiKey) {
    joule.providers.register(new OpenAIProvider({
      apiKey: config.providers.openai.apiKey,
      slmModel: config.providers.openai.models.slm,
      llmModel: config.providers.openai.models.llm,
    }));
  }

  if (config.providers.ollama?.enabled) {
    joule.providers.register(new OllamaProvider({
      baseUrl: config.providers.ollama.baseUrl,
      model: config.providers.ollama.models.slm,
    }));
  }

  // 3. Configure and register browser tools
  configureBrowser({
    headless: false,
    profileDirectory: 'Profile 1',
    ...config.browser,
  });

  joule.tools.register(browserNavigateTool, 'builtin');
  joule.tools.register(browserScreenshotTool, 'builtin');
  joule.tools.register(browserClickTool, 'builtin');
  joule.tools.register(browserWaitAndClickTool, 'builtin');
  joule.tools.register(browserTypeTool, 'builtin');
  joule.tools.register(browserExtractTool, 'builtin');
  joule.tools.register(browserObserveTool, 'builtin');
  joule.tools.register(browserEvaluateTool, 'builtin');

  console.log('Providers and tools registered.');
  console.log('Registered providers:', joule.providers.listAll().map(p => p.name).join(', '));
  console.log('Tools:', joule.tools.listNames().join(', '));
  console.log('');

  // 4. Submit the real browser task
  const task = {
    id: generateId('task'),
    description: [
      `Search YouTube for "${song}". Do these steps in order:`,
      `Step 1: Use browser_navigate to go to https://www.youtube.com/results?search_query=${encodeURIComponent(song)}`,
      `Step 2: Use browser_extract with selector 'a#video-title' to get the titles of the top search results.`,
    ].join(' '),
    budget: 'high' as const,
    createdAt: new Date().toISOString(),
  };

  console.log('Submitting task to Joule...');
  console.log(`Task: ${task.description.slice(0, 120)}...`);
  console.log('');

  const startTime = Date.now();

  const result = await joule.execute(task, (progress) => {
    process.stderr.write(`\r  [${progress.state}] ${progress.phase ?? ''}   `);
  });

  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 5. Print results
  console.log('');
  console.log(`=== Result (${elapsed}s) ===`);
  console.log(`Status: ${result.status}`);
  if (result.error) console.log(`Error: ${result.error}`);
  console.log('');

  console.log('--- Steps Executed ---');
  for (const step of result.stepResults) {
    const icon = step.success ? 'OK' : 'FAIL';
    console.log(`  [${icon}] ${step.toolName}: ${step.description}`);
    if (!step.success && step.error) {
      console.log(`        Error: ${step.error}`);
    }
    if (step.success && step.output) {
      const output = JSON.stringify(step.output).slice(0, 300);
      console.log(`        Output: ${output}${output.length >= 300 ? '...' : ''}`);
    }
  }
  console.log('');

  console.log('--- Budget ---');
  console.log(`  Tokens: ${result.budgetUsed.tokensUsed}`);
  console.log(`  Cost:   $${result.budgetUsed.costUsd.toFixed(4)}`);
  console.log(`  Time:   ${result.budgetUsed.elapsedMs}ms`);
  console.log(`  Energy: ${result.budgetUsed.energyWh.toFixed(6)} Wh`);
  console.log('');

  if (result.result) {
    console.log('--- Synthesis ---');
    console.log(result.result.slice(0, 500));
    console.log('');
  }

  if (result.simulationResult) {
    console.log('--- Simulation ---');
    console.log(`  Valid: ${result.simulationResult.valid}`);
    console.log(`  Issues: ${result.simulationResult.issues.length}`);
    for (const issue of result.simulationResult.issues) {
      console.log(`    [${issue.severity}] ${issue.type}: ${issue.message}`);
    }
    console.log('');
  }

  if (result.decisionGraph) {
    console.log('--- Decision Graph ---');
    console.log(`  Nodes: ${result.decisionGraph.nodes.length}`);
    console.log(`  Edges: ${result.decisionGraph.edges.length}`);
    console.log(`  Critical path: ${result.decisionGraph.criticalPath.length} steps`);
    console.log('');
  }

  // 6. Cleanup
  console.log('Cleaning up...');
  await closeBrowser();
  await joule.shutdown();
  console.log('Done!');
}

main().catch((err) => {
  console.error('E2E test failed:', err);
  process.exit(1);
});
