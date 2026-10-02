import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, CrewResult, Task } from '@joule/shared';
import {
  REPRO_PROMPT_VERSION,
  checkFidelity,
  generateRepros,
  loadReproChecks,
  readStoredRepros,
  renderFidelity,
  reproTaskDescription,
} from '../real-repo/repro.js';
import { REPRO_AUTHOR } from '../real-repo/crews.js';
import { DJANGO_ITEM, FLASK_ITEM, ITEM } from './real-repo-fixtures.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'joule-rr-repro-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const crew = (answer: string): CrewResult => ({
  crewName: 'x', status: 'completed', result: answer,
  agentResults: [{
    agentId: 'repro-author', role: 'Reproduction test author', blackboardWrites: [],
    budgetUsed: { tokensUsed: 5000, costUsd: 0.03 },
    taskResult: { id: 't', taskId: 't', traceId: 't', status: 'completed', result: answer, stepResults: [], completedAt: '', lifecycleMetrics: { modelCalls: 6, toolCalls: 9 } },
  }],
  budgetUsed: { tokensUsed: 5000, costUsd: 0.03 },
} as unknown as CrewResult);

describe('reproduction-test generation', () => {
  it('asks for a failing test of the issue at a fixed path, with nothing about the hidden tests', () => {
    const text = reproTaskDescription(FLASK_ITEM);
    expect(text).toContain(FLASK_ITEM.problem_statement);
    expect(text).toContain('at exactly this path: tests/test_joule_repro_check.py');
    expect(text).toContain('must FAIL on the current code');
    expect(text).toContain('Do not change any other file, and do not fix the bug.');
    expect(text).toContain('Run it with: python -m pytest -rA -p no:cacheprovider tests/test_joule_repro_check.py');
    // Nothing from the hidden tests or the fix reaches the author.
    expect(text).not.toContain('test_dotted_name');
    expect(text).not.toContain('test_blueprint_specific_error_handling');
    expect(text).not.toContain('src/flask/blueprints.py');
    // Django gets a test package and its own runner.
    const django = reproTaskDescription(DJANGO_ITEM);
    expect(django).toContain('tests/joule_repro_check/tests.py');
    expect(django).toContain('create an empty __init__.py');
    expect(django).toContain('python tests/runtests.py --settings=test_sqlite --parallel 1 joule_repro_check');
  });

  it('keeps earlier records and labels a retry pass with its attempt number', async () => {
    const earlier = [
      { instanceId: ITEM.instance_id, promptVersion: REPRO_PROMPT_VERSION, path: 'p', stored: true, chars: 10 },
      { instanceId: FLASK_ITEM.instance_id, promptVersion: REPRO_PROMPT_VERSION, path: 'p', stored: false, agentStatus: 'completed' },
    ];
    const records = await generateRepros([FLASK_ITEM], dir, REPRO_AUTHOR, {
      prepare: item => ({ container: `c-${item.instance_id}` }),
      runAgent: async () => crew('test_repro fails'),
      readFile: () => 'def test_repro():\n    assert False\n',
      reset: () => {},
    }, () => {}, { keep: [earlier[0]], attempt: 2 });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ instanceId: FLASK_ITEM.instance_id, stored: true, attempt: 2 });
    const lines = readFileSync(join(dir, 'repro.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => [l.instanceId, l.stored, l.attempt])).toEqual([
      [ITEM.instance_id, true, undefined],
      [FLASK_ITEM.instance_id, true, 2],
    ]);
  });

  it('records why the author run ended and what it called', async () => {
    const failed = crew('');
    const result = failed.agentResults[0].taskResult as unknown as Record<string, unknown>;
    result.status = 'failed';
    result.error = 'LLM returned empty response';
    const records = await generateRepros([ITEM], dir, REPRO_AUTHOR, {
      prepare: item => ({ container: `c-${item.instance_id}` }),
      runAgent: async () => failed,
      readFile: () => null,
      reset: () => {},
    });

    expect(records[0]).toMatchObject({ stored: false, agentStatus: 'failed', agentError: 'LLM returned empty response' });
  });

  it('runs one author per issue, stores the test on the host, and resets the container', async () => {
    const seen: Array<{ agent: AgentDefinition; task: Task }> = [];
    const resets: string[] = [];
    const records = await generateRepros([ITEM, FLASK_ITEM], dir, REPRO_AUTHOR, {
      prepare: item => ({ container: `c-${item.instance_id}` }),
      runAgent: async (agent, task) => { seen.push({ agent, task }); return crew('test_repro fails because the bug'); },
      readFile: (container, path) => (container.includes('flask') ? null : `# ${path}\ndef test_repro():\n    assert False\n`),
      reset: container => { resets.push(container); },
    });

    expect(seen.map(s => s.agent.id)).toEqual(['repro-author', 'repro-author']);
    // The author runs without a check: no gate, no hidden tests, no policy.
    for (const s of seen) expect(s.task.verifiedEdit).toBeUndefined();
    expect(resets).toEqual([`c-${ITEM.instance_id}`, `c-${FLASK_ITEM.instance_id}`]);

    expect(records[0]).toMatchObject({ instanceId: ITEM.instance_id, promptVersion: REPRO_PROMPT_VERSION, stored: true, tokens: 5000, modelCalls: 6, toolCalls: 9 });
    expect(readFileSync(join(dir, `${ITEM.instance_id}.py`), 'utf8')).toContain('def test_repro');
    expect(records[1]).toMatchObject({ stored: false });
    expect(existsSync(join(dir, `${FLASK_ITEM.instance_id}.py`))).toBe(false);
    expect(readFileSync(join(dir, 'repro.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect([...readStoredRepros(dir).keys()]).toEqual([ITEM.instance_id]);
  });

  it('records an author run that threw and still resets', async () => {
    const resets: string[] = [];
    const records = await generateRepros([ITEM], dir, REPRO_AUTHOR, {
      prepare: () => ({ container: 'c1' }),
      runAgent: async () => { throw new Error('no provider\n at stack'); },
      readFile: () => null,
      reset: c => { resets.push(c); },
    });
    expect(records[0]).toMatchObject({ stored: false, error: 'no provider' });
    expect(resets).toEqual(['c1']);
  });
});

describe('reproduction-test fidelity', () => {
  it('is faithful only when the test fails at base and passes with the upstream fix', () => {
    const repros = new Map([[ITEM.instance_id, 'def test_a(): pass'], [FLASK_ITEM.instance_id, 'def test_b(): pass'], [DJANGO_ITEM.instance_id, 'x']]);
    let gold = false;
    const ops: string[] = [];
    const rows = checkFidelity([ITEM, FLASK_ITEM, DJANGO_ITEM], repros, {
      prepare: item => { gold = false; ops.push(`prepare ${item.repo}`); return { container: item.instance_id }; },
      runProgram: (container, source) => {
        expect(source).toContain('EXISTING = False');
        // pytest item: faithful; flask item: passes even at base; django: never passes.
        if (container === ITEM.instance_id) return gold ? { status: 0, output: 'CHECK: reproduction test PASSED (1 passed, 0 failed)' } : { status: 1, output: 'CHECK: reproduction test FAILED (0 passed, 1 failed)' };
        if (container === FLASK_ITEM.instance_id) return { status: 0, output: 'CHECK: reproduction test PASSED (1 passed, 0 failed)' };
        return { status: 1, output: 'CHECK: reproduction test FAILED (0 passed, 0 failed)' };
      },
      applyGold: () => { gold = true; return { ok: true }; },
      reset: container => { ops.push(`reset ${container}`); },
    });

    expect(rows.map(r => [r.instanceId, r.failsAtBase, r.passesWithGold, r.faithful])).toEqual([
      [ITEM.instance_id, true, true, true],
      [FLASK_ITEM.instance_id, false, true, false],
      [DJANGO_ITEM.instance_id, true, false, false],
    ]);
    expect(ops.filter(o => o.startsWith('reset'))).toHaveLength(3);
    const table = renderFidelity(rows);
    expect(table).toContain(`| ${ITEM.instance_id} | yes | yes | **yes** |`);
    expect(table).toContain('Faithful: 1 of 3 stored reproduction tests.');
  });

  it('only lets a run use tests that were checked for fidelity', () => {
    writeFileSync(join(dir, `${ITEM.instance_id}.py`), 'def test_a(): pass\n');
    writeFileSync(join(dir, `${FLASK_ITEM.instance_id}.py`), 'def test_b(): pass\n');
    expect(() => loadReproChecks(dir)).toThrow('run repro-fidelity first');
    writeFileSync(join(dir, 'fidelity.json'), JSON.stringify([
      { instanceId: ITEM.instance_id, faithful: true },
      { instanceId: FLASK_ITEM.instance_id, faithful: false },
    ]));
    const checks = loadReproChecks(dir);
    expect(checks.get(ITEM.instance_id)).toEqual({ source: 'def test_a(): pass\n', faithful: true });
    expect(checks.get(FLASK_ITEM.instance_id)?.faithful).toBe(false);
  });
});
