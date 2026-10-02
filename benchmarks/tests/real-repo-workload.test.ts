import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatePolicy } from '../crew-scaling/tasks.js';
import { CHECK_LABELS, hiddenScorerSource, reproCheckSource, visibleF2pSource } from '../real-repo/checks.js';
import {
  CHECK_LABEL,
  captureDiff,
  checkerSource,
  prepareInstance,
  restoreBranch,
  runCheck,
  scoreHidden,
  type RealRepoRunRecord,
} from '../real-repo/workload.js';
import { DJANGO_ITEM, FLASK_ITEM, ITEM, TEST_PATCH, fakeDocker } from './real-repo-fixtures.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'joule-rr-workload-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A docker stand-in whose piped programs answer by kind: score, check, or anything else. */
function scriptedDocker(answers: { score?: string; scoreStatus?: number; check?: string; checkStatus?: number }) {
  return fakeDocker([], program => {
    if (program.includes('AFTER = "snapshot"')) return { stdout: answers.score ?? 'VERIFY: F2P 1/1, P2P 1/1\nALL REQUIRED TESTS PASS\n', status: answers.scoreStatus ?? 0 };
    return { stdout: answers.check ?? 'CHECK: reproduction test PASSED (1 passed, 0 failed)\n', status: answers.checkStatus ?? 0 };
  });
}

describe('real-repo checker placement', () => {
  it('leaves nothing in the container: not after prepare, not after a check', () => {
    const docker = fakeDocker(['/tmp/test.patch', '/tmp/check.py']);
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root });

    // A reused container's leftovers are gone, and nothing new was copied in.
    expect([...docker.tmp]).toEqual([]);
    expect(docker.calls.some(a => a[0] === 'cp')).toBe(false);

    const verdict = prepared.verify();
    expect(verdict.success).toBe(false);
    expect([...docker.tmp]).toEqual([]);
    expect(docker.calls.some(a => a[0] === 'cp')).toBe(false);

    // The only commands naming /tmp are the ones removing the old files.
    const naming = docker.execs.filter(c => c.includes('/tmp/'));
    expect(naming.every(c => c.startsWith('rm -f /tmp/test.patch /tmp/check.py'))).toBe(true);
  });

  it('pipes the host-side checker in on stdin for every check', () => {
    const docker = fakeDocker();
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root });
    const checker = join(root, 'unit', ITEM.instance_id, 'check.py');

    prepared.verify();
    runCheck(prepared.container, checker, docker.run);

    expect(docker.piped).toHaveLength(2);
    for (const input of docker.piped) expect(input).toBe(readFileSync(checker, 'utf8'));
    const exec = docker.calls.find(a => a[0] === 'exec' && a[a.length - 1].endsWith('python -'))!;
    expect(exec.slice(0, 3)).toEqual(['exec', '-i', prepared.container]);
    // The patch is kept on the host beside the checker, for inspection.
    expect(readFileSync(join(root, 'unit', ITEM.instance_id, 'test.patch'), 'utf8')).toBe(TEST_PATCH);
  });

  it('gives the gate a host command that needs nothing in the container, and a label to show', () => {
    const docker = fakeDocker();
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root });
    const policy = gatePolicy(prepared);

    expect(policy.command).toMatch(/^node ".*cli\.mjs" ".*run-check\.ts" "joule-rr-unit-pytest-dev__pytest-0001" ".*check\.py"$/);
    expect(policy.command).not.toContain('/tmp/');
    expect(policy.label).toBe(CHECK_LABEL);
    expect(policy.workspace).toBeDefined();
  });

  it('builds a checker that carries the patch itself and cleans up after the tests', () => {
    const source = checkerSource(ITEM);

    expect(source).not.toContain('/tmp');
    // Applied from memory, not from a file.
    expect(source).toContain('git apply --whitespace=nowarn -');
    expect(source).toContain(`PATCH = ${JSON.stringify(TEST_PATCH)}`);
    // No compiled copies of the hidden tests are written...
    expect(source).toContain('PYTHONDONTWRITEBYTECODE=1 python -m pytest');
    // ...and any an older check left are removed, per hidden-test file.
    expect(source).toContain("rm -f 'testing/__pycache__/test_existing'.*.pyc; rm -f 'testing/__pycache__/test_added'.*.pyc");
    // A file the patch added is removed rather than left behind.
    expect(source).toContain('git cat-file -e');
    expect(source).toContain('sh("rm -f -- %s" % q(f))');
    // The test files are restored even if the tests time out.
    expect(source).toContain('except subprocess.TimeoutExpired');
  });
});

describe('oracle mode is unchanged', () => {
  // Pinned before check modes existed (benchmarks/tests/fixtures/real-repo-oracle.json).
  const pinned = JSON.parse(readFileSync(new URL('./fixtures/real-repo-oracle.json', import.meta.url), 'utf8')) as Record<string, {
    checker: string; description: string; command: string; label: string; timeoutMs: number; policyKeys: string[];
    execs: string[]; verdict: { success: boolean; output: string };
  }>;

  for (const item of [ITEM, FLASK_ITEM]) {
    it(`matches the pinned checker, task, policy and commands byte for byte (${item.repo})`, () => {
      const want = pinned[item.instance_id];
      const docker = fakeDocker(['/tmp/test.patch', '/tmp/check.py']);
      const prepared = prepareInstance(item, 'unit', { docker: docker.run, root });
      const policy = gatePolicy(prepared);
      const verdict = prepared.verify();

      expect(checkerSource(item)).toBe(want.checker);
      expect(prepared.description).toBe(want.description);
      expect(policy.command.split(root).join('<ROOT>').replace(/node ".*?cli\.mjs" ".*?run-check\.ts"/, 'node "<TSX>" "<RUN_CHECK>"')).toBe(want.command);
      expect(policy.label).toBe(want.label);
      expect(policy.timeoutMs).toBe(want.timeoutMs);
      // No stage observer in oracle mode: the run between stages is as before.
      expect(Object.keys(policy).sort()).toEqual(want.policyKeys);
      expect(docker.execs).toEqual(want.execs);
      expect({ success: verdict.success, output: verdict.output }).toEqual(want.verdict);
    });
  }

  it('adds the hidden score to the record, read from the same check', () => {
    const prepared = prepareInstance(ITEM, 'unit', { docker: fakeDocker().run, root });
    const record = prepared.verify().record as RealRepoRunRecord;
    expect(record).toEqual({
      checkMode: 'oracle',
      hidden: { resolved: false, f2pPassed: 0, f2pTotal: 1, p2pFailed: 0, p2pTotal: 1 },
    });
  });
});

describe('hidden scoring', () => {
  it('runs the restoring scorer and reads its VERIFY line', () => {
    const docker = scriptedDocker({ score: 'VERIFY: F2P 1/2, P2P 3/4\nstill failing: x\n', scoreStatus: 1 });
    const score = scoreHidden('c1', ITEM, { docker: docker.run, dir: root });
    expect(score).toEqual({ resolved: false, f2pPassed: 1, f2pTotal: 2, p2pFailed: 1, p2pTotal: 4 });
    expect(docker.piped[0]).toBe(hiddenScorerSource(ITEM));
    // It leaves the repository exactly as it found it.
    expect(docker.piped[0]).toContain('AFTER = "snapshot"');
  });
});

describe('check modes', () => {
  it('visible-f2p: applies the failing tests at setup, names them in the task, checks only them', () => {
    const docker = scriptedDocker({ check: 'VERIFY: F2P 0/1\n', checkStatus: 1, score: 'VERIFY: F2P 0/1, P2P 1/1\n', scoreStatus: 1 });
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root, mode: 'visible-f2p' });

    const applied = docker.inputs.find(i => i.command === 'git apply --whitespace=nowarn -');
    expect(applied?.input).toBe(TEST_PATCH);
    expect(prepared.description).toContain('- testing/test_existing.py::test_hidden_regression');
    expect(prepared.description).toContain('They are in: testing/test_existing.py, testing/test_added.py');
    const policy = gatePolicy(prepared);
    expect(policy.label).toBe(CHECK_LABELS['visible-f2p']);
    expect(policy.command).toContain('check-visible-f2p.py');
    expect(readFileSync(join(root, 'unit', ITEM.instance_id, 'check-visible-f2p.py'), 'utf8')).toBe(visibleF2pSource(ITEM));

    const verdict = prepared.verify();
    expect(verdict.success).toBe(false);
    expect(verdict.record).toMatchObject({ checkMode: 'visible-f2p', checkFinalPassed: false, hidden: { resolved: false, f2pTotal: 1 } });
  });

  it('repro: the check carries the reproduction test; success is the hidden score, not the check', async () => {
    const docker = scriptedDocker({ score: 'VERIFY: F2P 0/1, P2P 1/1\n', scoreStatus: 1, check: 'CHECK: reproduction test PASSED (1 passed, 0 failed)\n', checkStatus: 0 });
    const source = 'def test_repro():\n    assert fixed()\n';
    const prepared = prepareInstance(ITEM, 'unit', { docker: docker.run, root, mode: 'repro', repro: { source, faithful: true } });
    const policy = gatePolicy(prepared);

    expect(policy.label).toBe(CHECK_LABELS.repro);
    expect(policy.command).toContain('check-repro.py');
    expect(readFileSync(join(root, 'unit', ITEM.instance_id, 'check-repro.py'), 'utf8')).toBe(reproCheckSource(ITEM, source, { existing: true }));
    // The task text says nothing about the reproduction test.
    expect(prepared.description).not.toContain('repro');

    // Staged stage observations: the hidden score, for the record only.
    expect(policy.observeStage).toBeDefined();
    const observed = await policy.observeStage!({ stage: 1, role: 'Implementer', passed: true });
    expect(observed).toEqual({ hidden: { resolved: false, f2pPassed: 0, f2pTotal: 1, p2pFailed: 0, p2pTotal: 1 } });

    const verdict = prepared.verify();
    // The check passes but the hidden tests do not: a false pass, kept visible.
    expect(verdict.success).toBe(false);
    expect(verdict.record).toEqual({
      checkMode: 'repro',
      checkFaithful: true,
      hidden: { resolved: false, f2pPassed: 0, f2pTotal: 1, p2pFailed: 0, p2pTotal: 1 },
      checkFinalPassed: true,
      stage1Hidden: { resolved: false, f2pPassed: 0, f2pTotal: 1, p2pFailed: 0, p2pTotal: 1 },
    });
  });

  it('repro: refuses to prepare without a reproduction test', () => {
    expect(() => prepareInstance(ITEM, 'unit', { docker: fakeDocker().run, root, mode: 'repro' })).toThrow('needs a reproduction test');
  });

  it('Django: adds the runner hint to the task and checks with runtests', () => {
    const prepared = prepareInstance(DJANGO_ITEM, 'unit', { docker: fakeDocker().run, root });
    expect(prepared.description).toContain('python tests/runtests.py --settings=test_sqlite --parallel 1 <module>');
    const checker = checkerSource(DJANGO_ITEM);
    expect(checker).toContain('./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 queries.tests admin_views.test_adminsite');
    expect(checker).toContain('LANG=en_US.UTF-8');
    expect(checker).toContain('AFTER = "base"');
  });
});

describe('branch points', () => {
  it('captures untracked work too, and replays it on a reset tree', () => {
    const docker = fakeDocker([], () => ({ stdout: '', status: 0 }));
    captureDiff('c1', ITEM, docker.run);
    restoreBranch('c1', ITEM, 'diff --git a/x b/x\n', docker.run);
    restoreBranch('c1', ITEM, '', docker.run);

    expect(docker.execs[0]).toBe('git add -A && git diff --cached --binary abc123');
    expect(docker.execs[1]).toMatch(/^git checkout -q abc123 -- \. && git checkout -q -- \. && git clean -fdq$/);
    expect(docker.inputs.find(i => i.command === 'git apply --binary --whitespace=nowarn -')?.input).toBe('diff --git a/x b/x\n');
    // An empty branch is just the base commit.
    expect(docker.execs.slice(3)).toEqual(['git checkout -q abc123 -- . && git checkout -q -- . && git clean -fdq']);
  });
});
