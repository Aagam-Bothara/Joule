/**
 * Adaptive escalation: a small model does the work, a large model is consulted
 * only when the evidence says the small one is stuck, and every decision is
 * visible in the trajectory.
 *
 * Needs two providers: one serving the small tier and one serving the large
 * tier. This example uses OpenRouter for a small open model and Google for the
 * large one; swap the models for anything the providers serve.
 *
 *   OPENROUTER_API_KEY=... JOULE_GOOGLE_API_KEY=... npx tsx examples/adaptive-escalation.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Joule, renderTrajectory } from '@joule/core';
import { OpenAIProvider, GoogleProvider } from '@joule/models';
import { fileReadTool, fileWriteTool, shellExecTool } from '@joule/tools';

async function main() {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const googleKey = process.env.JOULE_GOOGLE_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!openrouterKey || !googleKey) {
    console.error('Set OPENROUTER_API_KEY and JOULE_GOOGLE_API_KEY first.');
    process.exit(1);
  }

  // 1. Two tiers. `providerPriority` says which provider serves which rung;
  //    `adaptive` is the default mode, so nothing else is needed.
  const joule = new Joule({
    routing: {
      preferLocal: false,
      preferEfficientModels: false,
      slmConfidenceThreshold: 0.6,
      complexityThreshold: 0.7,
      providerPriority: { slm: ['openai'], llm: ['google'] },
      escalation: {
        maxSteps: 25,
        maxConsultations: 3,     // after this, the next escalation is a handoff
        consultMode: 'patch',    // the advisor may hand back a concrete edit
        staticChecks: true,      // compile-check every written Python file
      },
    },
    logging: { level: 'error', traceOutput: 'memory' },
  });
  await joule.initialize();

  // Small tier: an 8B open model through OpenRouter (OpenAI-compatible endpoint).
  joule.providers.register(new OpenAIProvider({
    apiKey: openrouterKey,
    baseUrl: 'https://openrouter.ai/api/v1',
    jsonMode: false,
    slmModel: 'meta-llama/llama-3.1-8b-instruct',
  }));
  // Large tier: Gemini Flash.
  joule.providers.register(new GoogleProvider({ apiKey: googleKey, llmModel: 'gemini-2.5-flash' }));

  joule.registerTool(fileReadTool);
  joule.registerTool(fileWriteTool);
  joule.registerTool(shellExecTool);

  // 2. A task with a deterministic check the agent can run itself.
  const dir = join(tmpdir(), 'joule-adaptive-example');
  mkdirSync(dir, { recursive: true });
  const tests = join(dir, 'run_tests.py');
  const solution = join(dir, 'solution.py');
  writeFileSync(tests, [
    'from solution import comb_sort',
    'assert comb_sort([5, 15, 37, 25, 79]) == [5, 15, 25, 37, 79]',
    'assert comb_sort([41, 32, 15, 19, 22]) == [15, 19, 22, 32, 41]',
    'assert comb_sort([99, 15, 13, 47]) == [13, 15, 47, 99]',
    'print("ALL TESTS PASSED")',
    '',
  ].join('\n'));

  const result = await joule.execute({
    description: [
      `Write a Python function named \`comb_sort\` that sorts a list with the comb sort algorithm and save it to "${solution}".`,
      `Run the tests with: python "${tests}" (working directory "${dir}"). They print ALL TESTS PASSED on success. Make them pass before you finish.`,
    ].join('\n'),
    budget: 'medium',
  });

  // 3. What happened, step by step: which tier acted, what the verifier saw,
  //    and where the policy consulted or handed off.
  console.log(renderTrajectory(result.trajectory!));
  console.log('');
  console.log(`Status: ${result.status}`);
  console.log(`Cost: $${result.budgetUsed.costUsd.toFixed(4)}  (estimated large-model-only: $${(result.trajectory?.estimatedLlmOnlyCostUsd ?? 0).toFixed(4)})`);

  await joule.shutdown();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
