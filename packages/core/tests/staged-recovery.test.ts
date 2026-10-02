import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { CrewOrchestrator } from '../src/crew-orchestrator.js';
import { ModelProviderRegistry } from '@joule/models';
import { fileWriteTool } from '@joule/tools';
import { ModelTier, generateId } from '@joule/shared';
import type { AgentDefinition, CrewDefinition, RoutingConfig, Task } from '@joule/shared';

/**
 * Staged recovery: run one agent, check the task's external verifier, and only
 * start the next agent if that check failed.
 *
 * The verifier here is a real command against a real directory — a node script
 * that passes once the file says GOOD — so the escalation decisions in these
 * tests are made the same way they are in production: by running the check,
 * never by asking the agent whether it thinks it finished.
 */

const ROLES = ['Implementer', 'Reviewer', 'Tester'] as const;

/** Scripted replies per role, in order. A role with none left answers plainly. */
type Script = Partial<Record<(typeof ROLES)[number], string[]>>;

function createMockProvider(script: Script, throwFor?: string) {
  const calls: string[] = [];
  const used: Record<string, number> = {};
  return {
    calls,
    provider: {
      name: 'ollama' as const,
      supportedTiers: [ModelTier.SLM, ModelTier.MID, ModelTier.LLM],
      isAvailable: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([
        { id: 'test-slm', name: 'Test SLM', tier: ModelTier.SLM, provider: 'ollama' },
      ]),
      estimateCost: vi.fn().mockReturnValue(0.001),
      chat: vi.fn().mockImplementation(async (request: { system?: string; messages: Array<{ content: string }> }) => {
        const system = request.system ?? '';
        const role = ROLES.find(r => system.includes(`You are: ${r}`)) ?? 'unknown';
        calls.push(role);
        if (throwFor && role === throwFor) throw new Error(`${role} provider failure (scripted)`);

        const queue = script[role as (typeof ROLES)[number]] ?? [];
        const i = used[role] ?? 0;
        used[role] = i + 1;
        const content = queue[i] ?? `{"answer": "${role} is finished"}`;
        return {
          model: 'test-slm',
          provider: 'ollama',
          tier: ModelTier.SLM,
          content,
          tokenUsage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
          latencyMs: 1,
          costUsd: 0.0001,
          finishReason: 'stop',
        };
      }),
      chatStream: vi.fn(),
    },
  };
}

const routing: RoutingConfig = {
  preferLocal: true,
  slmConfidenceThreshold: 0.6,
  complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], mid: ['ollama'], llm: ['ollama'] },
  maxReplanDepth: 2,
  unifiedPlanning: false,
};

const agentFor = (role: string): AgentDefinition => ({
  id: role.toLowerCase(),
  role,
  instructions: `You are the ${role}.`,
  allowedTools: ['file_write'],
  executionMode: 'direct',
  maxIterations: 4,
  maxRetries: 0,
});

// Every stage runs the check as a real subprocess, so these need more than the
// default per-test budget when the whole suite is competing for the CPU.
describe('staged recovery', { timeout: 60_000 }, () => {
  let budget: BudgetManager;
  let tracer: TraceLogger;
  let tools: ToolRegistry;
  let dir: string;

  beforeEach(() => {
    budget = new BudgetManager();
    tracer = new TraceLogger();
    tools = new ToolRegistry();
    tools.register(fileWriteTool, 'builtin');
    tools.register({
      name: 'noop',
      description: 'Does nothing',
      inputSchema: z.object({}).passthrough(),
      outputSchema: z.any(),
      execute: async () => ({ ok: true, detail: { nested: 'value' } }),
    }, 'builtin');

    dir = mkdtempSync(join(tmpdir(), 'joule-staged-'));
    // The external check: exit 0 only once the file says GOOD.
    writeFileSync(join(dir, 'check.js'), [
      'const fs = require("fs");',
      'const p = require("path").join(__dirname, "work.txt");',
      'if (!fs.existsSync(p)) process.exit(1);',
      'process.exit(fs.readFileSync(p, "utf8").includes("GOOD") ? 0 : 1);',
    ].join('\n'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const target = () => join(dir, 'work.txt').replace(/\\/g, '/');
  const write = (content: string) =>
    JSON.stringify({ tool_calls: [{ toolName: 'file_write', toolArgs: { path: target(), content } }] });

  const policy = () => ({ command: 'node check.js', cwd: dir, timeoutMs: 20_000 });

  function build(script: Script, opts: { throwFor?: string; agents?: string[] } = {}) {
    const { provider, calls } = createMockProvider(script, opts.throwFor);
    const providers = new ModelProviderRegistry();
    providers.register(provider as never);
    const router = new ModelRouter(providers, budget, routing);
    const planner = new Planner(router, tools, providers, budget, tracer);
    const orchestrator = new CrewOrchestrator(planner, budget, router, tracer, tools, providers, undefined, undefined, routing);

    const crew: CrewDefinition = {
      name: 'staged',
      strategy: 'staged_recovery',
      agents: (opts.agents ?? [...ROLES]).map(agentFor),
      budget: 'high',
    };
    return { orchestrator, crew, calls, provider };
  }

  async function run(
    orchestrator: CrewOrchestrator,
    crew: CrewDefinition,
    overrides: Partial<Task> = {},
  ) {
    const task: Task = {
      id: generateId('task'),
      description: 'Make the check pass',
      createdAt: new Date().toISOString(),
      verifiedEdit: policy(),
      ...overrides,
    };
    const envelope = budget.createEnvelope('high');
    const traceId = generateId('trace');
    tracer.createTrace(traceId, task.id, envelope.envelope);
    return orchestrator.executeCrew(crew, task, envelope, traceId);
  }

  it('1. stops after the primary when verification passes', async () => {
    const { orchestrator, crew, calls } = build({
      Implementer: [write('GOOD'), '{"answer": "done"}'],
    });

    const result = await run(orchestrator, crew);

    // The specialists are never built, never prompted, never charged.
    expect(calls.filter(c => c === 'Reviewer')).toHaveLength(0);
    expect(calls.filter(c => c === 'Tester')).toHaveLength(0);
    expect(result.staged?.stagesExecuted).toBe(1);
    expect(result.staged?.solvedAtStage).toBe(1);
    expect(result.staged?.solvedByRole).toBe('Implementer');
    expect(result.agentResults).toHaveLength(1);
    expect(result.status).toBe('completed');
  });

  it('2. escalates to the reviewer, and stops there when it repairs the workspace', async () => {
    const { orchestrator, crew, calls } = build({
      Implementer: [write('still broken'), '{"answer": "I am done"}'],
      Reviewer: [write('GOOD'), '{"answer": "fixed it"}'],
    });

    const result = await run(orchestrator, crew);

    expect(calls).toContain('Reviewer');
    expect(calls.filter(c => c === 'Tester')).toHaveLength(0);
    expect(result.staged?.stagesExecuted).toBe(2);
    expect(result.staged?.solvedAtStage).toBe(2);
    expect(result.staged?.solvedByRole).toBe('Reviewer');
    expect(result.staged?.stages[2]).toMatchObject({ executed: false, skipReason: 'verification_already_passed' });
    expect(result.status).toBe('completed');
  });

  it('3. escalates all the way to the tester', async () => {
    const { orchestrator, crew, calls } = build({
      Implementer: [write('still broken'), '{"answer": "done"}'],
      Reviewer: [write('also broken'), '{"answer": "looks fine to me"}'],
      Tester: [write('GOOD'), '{"answer": "repaired"}'],
    });

    const result = await run(orchestrator, crew);

    expect(calls).toContain('Tester');
    expect(result.staged?.stagesExecuted).toBe(3);
    expect(result.staged?.solvedAtStage).toBe(3);
    expect(result.staged?.solvedByRole).toBe('Tester');
    expect(result.status).toBe('completed');
  });

  it('4. reports failure when no stage makes the check pass', async () => {
    const { orchestrator, crew } = build({
      Implementer: ['{"answer": "done"}'],
      Reviewer: ['{"answer": "nothing wrong here"}'],
      Tester: ['{"answer": "cannot see it"}'],
    });

    const result = await run(orchestrator, crew);

    // Every agent reported success; the check disagreed, and it decides.
    expect(result.agentResults.every(r => r.taskResult.status === 'completed')).toBe(true);
    expect(result.staged?.verified).toBe(false);
    expect(result.staged?.solvedAtStage).toBeUndefined();
    expect(result.staged?.stagesExecuted).toBe(3);
    expect(result.status).toBe('failed');
  });

  it('5. still runs the reviewer when the primary throws', async () => {
    const { orchestrator, crew, calls } = build({
      Reviewer: [write('GOOD'), '{"answer": "recovered"}'],
    }, { throwFor: 'Implementer' });

    const result = await run(orchestrator, crew);

    expect(calls).toContain('Reviewer');
    expect(result.staged?.stages[0]).toMatchObject({ executed: true, status: 'failed' });
    expect(result.staged?.solvedByRole).toBe('Reviewer');
  });

  it('6. still runs the tester when the reviewer throws', async () => {
    const { orchestrator, crew, calls } = build({
      Implementer: ['{"answer": "done"}'],
      Tester: [write('GOOD'), '{"answer": "recovered"}'],
    }, { throwFor: 'Reviewer' });

    const result = await run(orchestrator, crew);

    expect(calls).toContain('Tester');
    expect(result.staged?.stagesExecuted).toBe(3);
    expect(result.staged?.solvedByRole).toBe('Tester');
  });

  it('7. gives the primary the same budget however many stages exist', async () => {
    const peers = vi.spyOn(budget, 'createPeerEnvelope');

    const one = build({ Implementer: ['{"answer": "done"}'] }, { agents: ['Implementer'] });
    await run(one.orchestrator, one.crew);
    const aloneCeiling = (peers.mock.results[0].value as { envelope: { maxTokens: number } }).envelope.maxTokens;

    peers.mockClear();
    const three = build({ Implementer: ['{"answer": "done"}'] });
    await run(three.orchestrator, three.crew);
    const withStages = (peers.mock.results[0].value as { envelope: { maxTokens: number } }).envelope.maxTokens;

    // Having recovery stages available costs the primary nothing.
    expect(withStages).toBe(aloneCeiling);
    peers.mockRestore();
  });

  it('8. hands the reviewer the verifier output, not just a summary', async () => {
    const { orchestrator, crew, provider } = build({
      Implementer: ['{"answer": "I wrote the fix and it works"}'],
      Reviewer: [write('GOOD'), '{"answer": "fixed"}'],
    });

    await run(orchestrator, crew);

    const reviewerCall = provider.chat.mock.calls.find(
      (c: [{ system?: string }]) => (c[0].system ?? '').includes('You are: Reviewer'),
    );
    const prompt = (reviewerCall![0] as { messages: Array<{ content: string }> }).messages
      .map(m => m.content).join('\n');

    expect(prompt).toContain('[Verification failure]');
    expect(prompt).toContain('node check.js');
    expect(prompt).toContain('run the check again');
    expect(prompt).toContain('[Previous agent: Implementer]');
    expect(prompt).toContain('I wrote the fix and it works');
    expect(prompt).toContain('[Current recovery objective]');
  });

  it('8a. names a labelled check instead of printing its command', async () => {
    const { orchestrator, crew, provider } = build({
      Implementer: ['{"answer": "I wrote the fix and it works"}'],
      Reviewer: [write('GOOD'), '{"answer": "fixed"}'],
    });

    await run(orchestrator, crew, { verifiedEdit: { ...policy(), label: "the repository's check" } });

    const reviewerCall = provider.chat.mock.calls.find(
      c => ((c[0] as { system?: string }).system ?? '').includes('You are: Reviewer'),
    );
    const prompt = (reviewerCall![0] as { messages: Array<{ content: string }> }).messages
      .map(m => m.content).join('\n');

    expect(prompt).toContain('[Verification failure]');
    expect(prompt).toContain("Check: the repository's check");
    expect(prompt).toContain('Result: FAILED');
    expect(prompt).not.toContain('node check.js');
    expect(prompt).not.toContain('Command:');
    expect(prompt).not.toContain(`(in ${dir})`);
    // It cannot be told to rerun a check it was only given the name of.
    expect(prompt).toContain('confirm the fix with the tests you can run');
    expect(prompt).not.toContain('run the check again');
  });

  it('8b. does not paste the previous agent"s tool-call JSON into the next prompt', async () => {
    // The shape a cut-off agent leaves behind: a little prose, then a raw blob.
    const partial = '(Partial - max iterations reached) I will try another approach.\n'
      + '{"tool_calls": [{"toolName": "shell_exec", "toolArgs": {"command": "dir"}}]}';
    const { orchestrator, crew, provider } = build({
      Implementer: [JSON.stringify({ answer: partial })],
      Reviewer: [write('GOOD'), '{"answer": "fixed"}'],
    });

    await run(orchestrator, crew);

    const reviewerCall = provider.chat.mock.calls.find(
      (c: [{ system?: string }]) => (c[0].system ?? '').includes('You are: Reviewer'),
    );
    // The handed-over task, not the whole conversation: the agent's own tool
    // calls legitimately appear later in its history.
    const handover = (reviewerCall![0] as { messages: Array<{ content: string }> }).messages[0].content;

    // The prose survives; the response-format blob does not, because agents
    // shown one imitate it and stop before doing any work.
    expect(handover).toContain('I will try another approach');
    expect(handover).not.toContain('"tool_calls"');
    expect(handover).not.toContain('"toolName"');
  });

  it('8c. strips tool-call protocol in every shape it arrives in', async () => {
    // All three reached a tester in the staged run: markup, a model's own
    // special tokens, and a fence left open at the end of an answer.
    const shapes = [
      'Prose first.\n<tool_calls>\n  <toolName>shell_exec</toolName>\n</tool_calls>',
      'Prose first.\n<｜DSML｜ll_func:shell_exec>\n  <command>cat pkg/report.py</command>',
      'Prose first.\n```json\n{"command": "python run_tests.py"}',
    ];

    for (const shape of shapes) {
      // Each shape starts from a failing workspace, or the previous iteration's
      // repair would make stage 1 pass and no reviewer would run.
      rmSync(join(dir, 'work.txt'), { force: true });
      const { orchestrator, crew, provider } = build({
        Implementer: [JSON.stringify({ answer: shape })],
        Reviewer: [write('GOOD'), '{"answer": "fixed"}'],
      });

      await run(orchestrator, crew);

      const reviewerCall = provider.chat.mock.calls.find(
        (c: [{ system?: string }]) => (c[0].system ?? '').includes('You are: Reviewer'),
      );
      const handover = (reviewerCall![0] as { messages: Array<{ content: string }> }).messages[0].content;

      expect(handover).toContain('Prose first.');
      expect(handover).not.toContain('<tool_calls>');
      expect(handover).not.toContain('｜DSML');
      expect(handover).not.toContain('```json');
      expect(handover).not.toContain('toolName');
    }
  });

  it('9. never hands an agent a coerced object', async () => {
    const { orchestrator, crew, provider } = build({
      Implementer: [
        JSON.stringify({ tool_calls: [{ toolName: 'noop', toolArgs: {} }] }),
        '{"answer": "done"}',
      ],
      Reviewer: [write('GOOD'), '{"answer": "fixed"}'],
    });

    await run(orchestrator, crew);

    for (const call of provider.chat.mock.calls) {
      const prompt = [(call[0] as { system?: string }).system ?? '',
        ...(call[0] as { messages: Array<{ content: string }> }).messages.map(m => m.content)].join('\n');
      expect(prompt).not.toContain('[object Object]');
    }
  });

  it('10. rolls back a recovery edit that breaks a verified workspace', async () => {
    const { orchestrator, crew } = build({
      // The primary gets it working; the reviewer then makes it worse.
      Implementer: [write('GOOD'), '{"answer": "done"}'],
      Reviewer: [write('BROKEN'), '{"answer": "changed it"}'],
    });

    // Force the reviewer to run even though the primary passed, by checking the
    // gate directly on a sequential crew: staged would skip it, and the point
    // here is the gate, not the skip.
    const sequential: CrewDefinition = { ...crew, strategy: 'sequential' };
    await run(orchestrator, sequential);

    // The working version survived the reviewer's edit.
    expect(readFileSync(join(dir, 'work.txt'), 'utf8')).toBe('GOOD');
  });

  it('11. marks skipped stages as skipped rather than as agents that did nothing', async () => {
    const { orchestrator, crew } = build({ Implementer: [write('GOOD'), '{"answer": "done"}'] });

    const result = await run(orchestrator, crew);
    const [primary, reviewer, tester] = result.staged!.stages;

    expect(primary).toMatchObject({ executed: true, stage: 1 });
    expect(primary.modelCalls).toBeGreaterThan(0);
    for (const skipped of [reviewer, tester]) {
      expect(skipped.executed).toBe(false);
      expect(skipped.skipReason).toBe('verification_already_passed');
      // No fabricated zero-work result: it has no status, no counts, no cost.
      expect(skipped.status).toBeUndefined();
      expect(skipped.modelCalls).toBeUndefined();
      expect(skipped.costUsd).toBeUndefined();
    }
    // Only the agents that ran appear as results.
    expect(result.agentResults).toHaveLength(1);
  });

  it('12. refuses to guess when the task has no external verifier', async () => {
    const { orchestrator, crew, calls } = build({ Implementer: ['{"answer": "done"}'] });

    const result = await run(orchestrator, crew, { verifiedEdit: undefined });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('staged_recovery requires task.verifiedEdit');
    expect(calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // verified_full: the control that keeps the checks and the handoff but drops
  // the early stop, so the two things staged recovery changes can be told apart.
  // ---------------------------------------------------------------------------

  describe('verified_full', () => {
    const verifiedFull = (crew: CrewDefinition): CrewDefinition => ({ ...crew, strategy: 'verified_full' });

    it('V1. runs every stage even when the primary already passed', async () => {
      const { orchestrator, crew, calls } = build({
        Implementer: [write('GOOD'), '{"answer": "done"}'],
      });

      const result = await run(orchestrator, verifiedFull(crew));

      expect(result.staged?.stagesExecuted).toBe(3);
      expect(calls).toContain('Reviewer');
      expect(calls).toContain('Tester');
      expect(result.staged?.stages.every(s => s.executed)).toBe(true);
      expect(result.staged?.solvedAtStage).toBe(1);
    });

    it('V2. tells the reviewer the truth when verification passed', async () => {
      const { orchestrator, crew, provider } = build({
        Implementer: [write('GOOD'), '{"answer": "all good"}'],
      });

      await run(orchestrator, verifiedFull(crew));

      const reviewerCall = provider.chat.mock.calls.find(
        (c: [{ system?: string }]) => (c[0].system ?? '').includes('You are: Reviewer'),
      );
      const handover = (reviewerCall![0] as { messages: Array<{ content: string }> }).messages[0].content;

      // No invented failure to chase.
      expect(handover).toContain('Result: PASSED');
      expect(handover).not.toContain('Result: FAILED');
      expect(handover).toContain('External verification currently passes');
      expect(handover).toContain('only if you identify a concrete defect');
    });

    it('V3. hands the reviewer the real failure when the primary failed', async () => {
      const { orchestrator, crew, provider } = build({
        Implementer: [write('still broken'), '{"answer": "done"}'],
      });

      await run(orchestrator, verifiedFull(crew));

      const reviewerCall = provider.chat.mock.calls.find(
        (c: [{ system?: string }]) => (c[0].system ?? '').includes('You are: Reviewer'),
      );
      const handover = (reviewerCall![0] as { messages: Array<{ content: string }> }).messages[0].content;

      expect(handover).toContain('[Verification failure]');
      expect(handover).toContain('Result: FAILED');
      expect(handover).toContain('node check.js');
    });

    it('V4. still runs the tester after the reviewer repairs the workspace', async () => {
      const { orchestrator, crew, calls } = build({
        Implementer: [write('still broken'), '{"answer": "done"}'],
        Reviewer: [write('GOOD'), '{"answer": "fixed"}'],
      });

      const result = await run(orchestrator, verifiedFull(crew));

      expect(calls).toContain('Tester');
      expect(result.staged?.stagesExecuted).toBe(3);
      expect(result.staged?.solvedAtStage).toBe(2);
    });

    it('V5. gives the tester the verification from the reviewer stage', async () => {
      const { orchestrator, crew, provider } = build({
        Implementer: [write('still broken'), '{"answer": "done"}'],
        Reviewer: [write('GOOD'), '{"answer": "I fixed the file"}'],
      });

      await run(orchestrator, verifiedFull(crew));

      const testerCall = provider.chat.mock.calls.find(
        (c: [{ system?: string }]) => (c[0].system ?? '').includes('You are: Tester'),
      );
      const handover = (testerCall![0] as { messages: Array<{ content: string }> }).messages[0].content;

      // The reviewer's stage passed, so that is what the tester is told.
      expect(handover).toContain('Result: PASSED');
      expect(handover).toContain('[Previous agent: Reviewer]');
      expect(handover).toContain('I fixed the file');
    });

    it('V6. reports the final verifier, not what the agents claimed', async () => {
      const { orchestrator, crew } = build({
        Implementer: ['{"answer": "done"}'],
        Reviewer: ['{"answer": "looks right"}'],
        Tester: ['{"answer": "all green"}'],
      });

      const result = await run(orchestrator, verifiedFull(crew));

      expect(result.agentResults.every(r => r.taskResult.status === 'completed')).toBe(true);
      expect(result.staged?.verified).toBe(false);
      expect(result.status).toBe('failed');
    });

    it('V7. gives every stage the same envelope', async () => {
      const peers = vi.spyOn(budget, 'createPeerEnvelope');
      const { orchestrator, crew } = build({ Implementer: [write('GOOD'), '{"answer": "done"}'] });

      await run(orchestrator, verifiedFull(crew));

      const ceilings = peers.mock.results.map(r => (r.value as { envelope: { maxTokens: number } }).envelope.maxTokens);
      expect(ceilings).toHaveLength(3);
      expect(new Set(ceilings).size).toBe(1);
      peers.mockRestore();
    });

    it('V8/V9. leaves sequential and staged behaving exactly as before', async () => {
      // Sequential: everyone runs, no staged account at all.
      const seq = build({
        Implementer: [write('GOOD'), '{"answer": "done"}'],
        Reviewer: ['{"answer": "reviewed"}'],
        Tester: ['{"answer": "tested"}'],
      });
      const sequential = await run(seq.orchestrator, { ...seq.crew, strategy: 'sequential' });
      expect(sequential.agentResults).toHaveLength(3);
      expect(sequential.staged).toBeUndefined();

      rmSync(join(dir, 'work.txt'), { force: true });

      // Staged: a passing primary still stops the run.
      const stg = build({ Implementer: [write('GOOD'), '{"answer": "done"}'] });
      const staged = await run(stg.orchestrator, stg.crew);
      expect(staged.staged?.stagesExecuted).toBe(1);
      expect(stg.calls).not.toContain('Reviewer');
    });

    it('V10. rolls back a specialist edit that breaks an already-passing workspace', async () => {
      const { orchestrator, crew } = build({
        Implementer: [write('GOOD'), '{"answer": "done"}'],
        // Runs only because this arm always runs, and makes things worse.
        Reviewer: [write('BROKEN'), '{"answer": "changed it"}'],
      });

      const result = await run(orchestrator, verifiedFull(crew));

      expect(readFileSync(join(dir, 'work.txt'), 'utf8')).toBe('GOOD');
      const reviewer = result.agentResults[1];
      expect(reviewer.taskResult.verifiedEdits).toMatchObject({ rollbacks: 1 });
      expect(result.staged?.verified).toBe(true);
    });
  });

  it('13. leaves the other strategies exactly as they were', async () => {
    const { orchestrator, crew, calls } = build({
      Implementer: [write('GOOD'), '{"answer": "done"}'],
      Reviewer: ['{"answer": "reviewed"}'],
      Tester: ['{"answer": "tested"}'],
    });

    const sequential: CrewDefinition = { ...crew, strategy: 'sequential' };
    const result = await run(orchestrator, sequential);

    // Sequential still runs everyone regardless of the check, and reports no
    // staged account at all.
    expect(calls).toContain('Reviewer');
    expect(calls).toContain('Tester');
    expect(result.agentResults).toHaveLength(3);
    expect(result.staged).toBeUndefined();
    expect(result.status).toBe('completed');
  });
});
