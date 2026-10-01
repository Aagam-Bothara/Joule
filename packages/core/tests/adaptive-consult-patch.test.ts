import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetManager } from '../src/budget-manager.js';
import { TraceLogger } from '../src/trace-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ModelRouter } from '../src/model-router.js';
import { Planner } from '../src/planner.js';
import { TaskExecutor } from '../src/task-executor.js';
import { parsePatchReply } from '../src/adaptive/consultant.js';
import { staticCheck } from '../src/adaptive/verifier.js';
import { ModelProviderRegistry } from '@joule/models';
import { ModelTier, generateId } from '@joule/shared';
import type { Task, RoutingConfig, ChatMessage, ModelRequest, EscalationPolicyConfig } from '@joule/shared';

// ── Scripted provider (same shape as adaptive-executor.test.ts) ─────

interface Scripts { slm?: string[]; llm?: string[] }

function scriptedProvider(scripts: Scripts) {
  const idx = { slm: 0, llm: 0 };
  const calls: Array<{ tier: 'slm' | 'llm'; system: string; messages: ChatMessage[]; responseFormat?: string }> = [];
  const provider = {
    name: 'ollama' as const,
    supportedTiers: [ModelTier.SLM, ModelTier.LLM],
    isAvailable: async () => true,
    listModels: async () => [
      { id: 'test-slm', name: 'SLM', tier: ModelTier.SLM, contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
      { id: 'test-llm', name: 'LLM', tier: ModelTier.LLM, contextWindow: 8000, costPerInputToken: 0, costPerOutputToken: 0 },
    ],
    estimateCost: (_n: number, model: string) => (model === 'test-llm' ? 0.01 : 0.0005),
    chat: async (req: ModelRequest) => {
      const tier = req.tier === ModelTier.LLM ? 'llm' : 'slm';
      calls.push({ tier, system: req.system ?? '', messages: req.messages.map(m => ({ ...m })), responseFormat: req.responseFormat });
      const list = scripts[tier] ?? [];
      const content = list[Math.min(idx[tier], list.length - 1)] ?? '{}';
      idx[tier]++;
      return {
        model: `test-${tier}`, provider: 'ollama' as const, tier: req.tier, content,
        tokenUsage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, latencyMs: 5, costUsd: tier === 'llm' ? 0.01 : 0.0005, finishReason: 'stop' as const,
      };
    },
    chatStream: async function* () { yield { content: '', done: true }; },
  };
  return { provider, calls };
}

const routing: RoutingConfig = {
  preferLocal: true, slmConfidenceThreshold: 0.6, complexityThreshold: 0.7,
  providerPriority: { slm: ['ollama'], llm: ['ollama'] }, maxReplanDepth: 2, unifiedPlanning: false,
};

function build(scripts: Scripts, tools: ToolRegistry, escalation: EscalationPolicyConfig = {}) {
  const budget = new BudgetManager();
  const tracer = new TraceLogger();
  const providers = new ModelProviderRegistry();
  const scripted = scriptedProvider(scripts);
  providers.register(scripted.provider as any);
  const cfg = { ...routing, escalation };
  const router = new ModelRouter(providers, budget, cfg);
  const planner = new Planner(router, tools, providers, budget, tracer);
  const executor = new TaskExecutor(budget, router, tracer, tools, planner, providers, undefined, cfg);
  return { executor, calls: scripted.calls };
}

const task = (description: string): Task => ({ id: generateId('task'), description, budget: 'high', mode: 'adaptive', createdAt: new Date().toISOString() });
const toolCall = (toolName: string, toolArgs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action: 'tool_call', thought: 't', toolName, toolArgs, plan: ['a', 'b'], ...extra });
const finalAnswer = (answer: string, extra: Record<string, unknown> = {}) => JSON.stringify({ action: 'final_answer', answer, ...extra });

// ── Tools: an in-memory file system and a fake test runner ──────────

let tools: ToolRegistry;
let files: Map<string, string>;
let dir: string;

beforeEach(() => {
  tools = new ToolRegistry();
  files = new Map();
  dir = mkdtempSync(join(tmpdir(), 'joule-consult-'));
  tools.register({
    name: 'file_write',
    description: 'write',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    outputSchema: z.any(),
    execute: async (args) => { files.set(args.path, args.content); return { path: args.path, bytesWritten: args.content.length }; },
  }, 'builtin');
  tools.register({
    name: 'shell_exec',
    description: 'fake tests: pass when the solution contains "return sorted"',
    inputSchema: z.object({ command: z.string(), cwd: z.string().optional() }).passthrough(),
    outputSchema: z.any(),
    execute: async () => {
      const ok = (files.get('solution.py') ?? '').includes('return sorted');
      return { stdout: ok ? '3/3 tests passed\nALL TESTS PASSED' : '1/3 tests passed', stderr: '', exitCode: ok ? 0 : 1 };
    },
  }, 'builtin');
});

// ── Tests ───────────────────────────────────────────────────────────

describe('patch-mode consultations', () => {
  it('applies the consultant\'s edit through the write tool, attributes it to the LLM, and the SLM finishes', async () => {
    const run = toolCall('shell_exec', { command: 'python run_tests.py' });
    const { executor, calls } = build({
      slm: [
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return x' }),
        run, // 1/3 -> verification fails (retry allowed)
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return x[::-1]' }),
        run, // 1/3 again -> no improvement -> consult
        run, // after the applied edit: passes
        finalAnswer('done'),
      ],
      llm: [JSON.stringify({ advice: 'Return the sorted list.', edits: [{ path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }] })],
    }, tools);

    const result = await executor.execute(task('Write f in "solution.py" and make the tests pass'));

    expect(result.status).toBe('completed');
    const t = result.trajectory!;
    expect(t.consultations).toBe(1);
    expect(t.handoffs).toBe(0);
    expect(files.get('solution.py')).toBe('def f(x):\n    return sorted(x)');

    // The consultant saw the current file and was asked for JSON.
    const llm = calls.filter(c => c.tier === 'llm');
    expect(llm).toHaveLength(1);
    expect(llm[0].responseFormat).toBe('json');
    expect(llm[0].messages[0].content).toContain('CURRENT FILES');
    expect(llm[0].messages[0].content).toContain('return x[::-1]');

    // The applied edit is a step of its own, attributed to the LLM tier and the consult.
    const edit = result.stepResults.find(s => s.description?.includes('applied edit'));
    expect(edit).toBeDefined();
    expect(edit!.tier).toBe(ModelTier.LLM);
    expect(edit!.model).toBe('test-llm');
    expect(edit!.consultId).toBe('c1');
    expect(t.steps.some(s => s.reason.includes('edit applied by consult c1'))).toBe(true);

    // The SLM was told the edit is in place and asked to verify.
    const slmAfter = calls.filter(c => c.tier === 'slm').at(-2)!;
    expect(slmAfter.messages.at(-1)?.content).toContain('already applied');
    expect(slmAfter.messages.at(-1)?.content).toContain('tool="file_write"');
  });

  it('search/replace edits must match exactly once; unmatched edits are dropped and the advice still returns', async () => {
    const run = toolCall('shell_exec', { command: 'python run_tests.py' });
    const { executor } = build({
      slm: [
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return x' }),
        run,
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return list(x)' }),
        run,
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }),
        run,
        finalAnswer('done'),
      ],
      llm: [JSON.stringify({ advice: 'Sort it.', edits: [
        { path: 'solution.py', search: 'return list(x)', replace: 'return sorted(x)' },
        { path: 'other.py', content: 'nope' },
        { path: 'solution.py', search: 'not in the file', replace: 'x' },
      ] })],
    }, tools);

    const result = await executor.execute(task('Write f in "solution.py"'));
    expect(result.status).toBe('completed');
    expect(result.trajectory!.consultations).toBe(1);
    const edits = result.stepResults.filter(s => s.description?.includes('applied edit'));
    expect(edits).toHaveLength(1);
    expect(files.get('solution.py')).toBe('def f(x):\n    return sorted(x)');
    expect(files.has('other.py')).toBe(false);
  });

  it('advice mode keeps consultations prose-only', async () => {
    const run = toolCall('shell_exec', { command: 'python run_tests.py' });
    const { executor, calls } = build({
      slm: [
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return x' }),
        run, run,
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }),
        run,
        finalAnswer('done'),
      ],
      llm: ['Return sorted(x).'],
    }, tools, { consultMode: 'advice' });

    const result = await executor.execute(task('Write f in "solution.py"'));
    expect(result.status).toBe('completed');
    const llm = calls.filter(c => c.tier === 'llm');
    expect(llm[0].responseFormat).toBe('text');
    expect(llm[0].messages[0].content).not.toContain('CURRENT FILES');
    expect(result.stepResults.some(s => s.description?.includes('applied edit'))).toBe(false);
  });

  it('parsePatchReply tolerates fences, prose replies and malformed edits', () => {
    expect(parsePatchReply('```json\n{"advice":"a","edits":[{"path":"x.py","content":"1"}]}\n```')).toEqual({ advice: 'a', edits: [{ path: 'x.py', content: '1' }] });
    expect(parsePatchReply('Just do it.')).toEqual({ advice: 'Just do it.', edits: [] });
    expect(parsePatchReply('{"advice":"a","edits":[{"path":""},{"path":"y.py","search":"s"},{"path":"z.py","search":"s","replace":"r"}]}').edits).toEqual([{ path: 'z.py', search: 's', replace: 'r' }]);
  });
});

describe('ablation switches', () => {
  it('verification: none skips exit-code checks, so a failing test run does not count as a failure', async () => {
    const run = toolCall('shell_exec', { command: 'python run_tests.py' });
    const { executor, calls } = build({
      slm: [toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return x' }), run, run, run, finalAnswer('done')],
      llm: ['{"advice":"x","edits":[]}'],
    }, tools, { verification: 'none' });
    const result = await executor.execute(task('Write f in "solution.py"'));
    expect(result.status).toBe('completed');
    expect(result.stepResults.every(s => s.verified === undefined)).toBe(true);
    expect(result.trajectory!.consultations).toBe(0);
    expect(calls.filter(c => c.tier === 'llm')).toHaveLength(0);
  });

  it('confidenceSource: self-report asks for a confidence number and uses it as the composite', async () => {
    const run = toolCall('shell_exec', { command: 'python run_tests.py' });
    const { executor, calls } = build({
      slm: [
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return x' }, { confidence: 0.9 }),
        run, // fails verification but the model claims 0.9
        finalAnswer('done', { confidence: 0.95 }),
      ],
      llm: ['{"advice":"x","edits":[]}'],
    }, tools, { confidenceSource: 'self-report' });
    const result = await executor.execute(task('Write f in "solution.py"'));
    expect(calls[0].system).toContain('"confidence"');
    expect(result.stepResults[0].selfConfidence).toBe(0.9);
    const d = result.trajectory!.decisions;
    expect(d[0].confidence.selfReported).toBe(0.9);
    expect(d[0].score).toBe(0.9);
    // Evidence sub-signals are still recorded alongside the claim.
    expect(d[1].confidence.verification).toBe(0);
    expect(d[1].score).toBe(0.9);
  });
});

describe('policy switches for repository work', () => {
  it('finalAnswerRequires: write refuses an early final answer, counts it, and accepts one after a write', async () => {
    const { executor, calls } = build({
      slm: [
        toolCall('shell_exec', { command: 'grep -rn foo src/' }),
        finalAnswer('nothing to do'),
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }),
        finalAnswer('done'),
      ],
      llm: ['{"advice":"x","edits":[]}'],
    }, tools, { finalAnswerRequires: 'write' });
    const result = await executor.execute(task('Fix the bug in "solution.py"'));
    expect(result.status).toBe('completed');
    expect(result.result).toBe('done');
    const t = result.trajectory!;
    expect(t.steps[1].description).toContain('refused');
    expect(t.steps[1].action).toBe('continue'); // one refusal is the agent's to fix; repeats escalate
    expect(calls[2].messages.at(-1)?.content).toContain('not accepted');
    expect(t.consultations).toBe(0);
  });

  it('a search command that finds nothing (exit 1) is not a verification failure', async () => {
    tools.register({
      name: 'repo_shell',
      description: 'grep exits 1 when nothing matches',
      inputSchema: z.object({ command: z.string() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ stdout: '', stderr: '', exitCode: (args.command as string).startsWith('grep') ? 1 : 0 }),
    }, 'builtin');
    const { executor } = build({
      slm: [
        toolCall('repo_shell', { command: 'grep -rn nothing src/' }),
        toolCall('repo_shell', { command: 'grep -rn nothing_else src/' }),
        toolCall('repo_shell', { command: 'grep -rn still_nothing src/' }),
        finalAnswer('done'),
      ],
      llm: ['{"advice":"x","edits":[]}'],
    }, tools);
    const result = await executor.execute(task('Explore the repository'));
    expect(result.status).toBe('completed');
    expect(result.stepResults.every(s => s.verified === true)).toBe(true);
    expect(result.trajectory!.consultations).toBe(0);
    expect(result.trajectory!.handoffs).toBe(0);
  });
});

describe('verified finish and per-rung steps', () => {
  it('finalAnswerRequires: verified refuses a final answer until a check passes after the last write', async () => {
    const { executor, calls } = build({
      slm: [
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }),
        finalAnswer('done without checking'),
        toolCall('shell_exec', { command: 'python run_tests.py' }),  // passes
        finalAnswer('done'),
      ],
      llm: ['{"advice":"x","edits":[]}'],
    }, tools, { finalAnswerRequires: 'verified' });
    const result = await executor.execute(task('Fix f in "solution.py"'));
    expect(result.status).toBe('completed');
    expect(result.result).toBe('done');
    expect(result.trajectory!.steps[1].description).toContain('unverified change');
    expect(calls[2].messages.at(-1)?.content).toContain('nothing has been verified');
  });

  it('rungLocalSteps gives the model after a handoff a fresh step allowance', async () => {
    const { executor } = build({
      slm: ['not an action', 'still prose'],                    // breakdown at steps 0-1 -> handoff
      llm: [
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }),
        toolCall('shell_exec', { command: 'python run_tests.py' }),
        finalAnswer('done'),
      ],
    }, tools, { maxSteps: 3, rungLocalSteps: true });
    const result = await executor.execute(task('Fix f in "solution.py"'));
    // Without rung-local steps the cap of 3 would have ended the run right after the handoff.
    expect(result.status).toBe('completed');
    expect(result.trajectory!.handoffs).toBe(1);
    expect(result.trajectory!.trajectoryLength).toBeGreaterThan(3);
  });
});

describe('exploration stall', () => {
  it('eight successful reads with no write and no verification trigger a consult; a write resets the window', async () => {
    tools.register({
      name: 'repo_read',
      description: 'read',
      inputSchema: z.object({ path: z.string() }).passthrough(),
      outputSchema: z.any(),
      execute: async (args) => ({ content: `contents of ${args.path}`, path: args.path }),
    }, 'builtin');
    const read = (i: number) => toolCall('repo_read', { path: `file${i}.py` });
    const { executor } = build({
      slm: [
        ...Array.from({ length: 8 }, (_, i) => read(i)),   // 8 reads -> consult
        read(8), read(9),                                   // window reset by the consult
        toolCall('file_write', { path: 'solution.py', content: 'def f(x):\n    return sorted(x)' }),
        ...Array.from({ length: 7 }, (_, i) => read(20 + i)), // 7 reads after a write: not enough
        finalAnswer('done'),
      ],
      llm: ['{"advice":"Look at solution.py and change f.","edits":[]}'],
    }, tools);
    const result = await executor.execute(task('Fix f in "solution.py"'));
    expect(result.status).toBe('completed');
    const t = result.trajectory!;
    expect(t.consultations).toBe(1);
    expect(t.steps[7].action).toBe('consult');
    expect(t.steps[7].reason).toContain('reading and searching');
    expect(t.steps.filter(s => s.action === 'consult')).toHaveLength(1);
  });
});

describe('action parsing', () => {
  it('recovers an action when the model closes the object early and keeps writing', async () => {
    const { StepAgent } = await import('../src/adaptive/step-agent.js');
    const raw = '{"action":"tool_call","thought":"search","toolName":"repo_shell","toolArgs":{"command":"grep -n \\"def __set__\\" django/db/models/fields/related.py"}},"plan":["Find __set__","Read it"]}';
    const action = StepAgent.parseAction(raw);
    expect(action.type).toBe('tool_call');
    if (action.type === 'tool_call') {
      expect(action.toolName).toBe('repo_shell');
      expect(action.toolArgs.command).toBe('grep -n "def __set__" django/db/models/fields/related.py');
    }
  });

  it('still rejects an unterminated action', async () => {
    const { StepAgent } = await import('../src/adaptive/step-agent.js');
    expect(StepAgent.parseAction('{"action":"tool_call","toolName":"repo_shell","toolArgs":{"command":"python -c \\"').type).toBe('malformed');
  });
});

describe('static checks', () => {
  it('staticCheck compiles Python and reports the syntax error line', async () => {
    const good = join(dir, 'good.py');
    const bad = join(dir, 'bad.py');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(good, 'def f():\n    return 1\n');
    writeFileSync(bad, 'def f(:\n    return 1\n');
    const g = await staticCheck(good);
    const b = await staticCheck(bad);
    if (g.kind === 'none') return; // no python on this machine: nothing to assert
    expect(g).toMatchObject({ passed: true, kind: 'static_check' });
    expect(b.passed).toBe(false);
    expect(b.kind).toBe('static_check');
    expect(b.evidence).toMatch(/SyntaxError|invalid syntax/i);
    expect(await staticCheck(join(dir, 'notes.txt'))).toMatchObject({ kind: 'none' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('a written file that does not compile is reported to the agent and counted as a cheap slip, not a failure', async () => {
    const realWrite = tools;
    // A write tool that lands on disk so py_compile can run.
    realWrite.register({
      name: 'file_write',
      description: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      outputSchema: z.any(),
      execute: async (args) => { const { writeFileSync } = await import('node:fs'); writeFileSync(args.path, args.content); files.set('solution.py', args.content); return { path: args.path }; },
    }, 'builtin');
    const path = join(dir, 'solution.py');
    const { executor, calls } = build({
      slm: [
        toolCall('file_write', { path, content: 'def f(x)\n    return x' }), // missing colon
        toolCall('file_write', { path, content: 'def f(x):\n    return sorted(x)' }),
        finalAnswer('done'),
      ],
      llm: ['{"advice":"x","edits":[]}'],
    }, realWrite);
    const result = await executor.execute(task(`Write f in "${path}"`));
    const first = result.stepResults[0];
    if (first.verifierKind !== 'static_check') return; // no python available
    expect(first.success).toBe(true);
    expect(first.verified).toBe(false);
    expect(first.verifyEvidence).toMatch(/SyntaxError|invalid syntax/i);
    // The agent saw the error line in its observation.
    expect(calls[1].messages.at(-1)?.content).toContain('static check failed');
    expect(result.stepResults[1].verified).toBe(true);
    expect(result.trajectory!.consultations).toBe(0);
    expect(result.trajectory!.handoffs).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('sorted');
    rmSync(dir, { recursive: true, force: true });
  });
});
