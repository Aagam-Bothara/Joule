import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, fixtureById } from '../specialist-value/fixtures.js';
import { prepareFixture, testScript } from '../specialist-value/tasks.js';
import { renderSelfTest, selfTestAll } from '../specialist-value/selftest.js';
import {
  abstention,
  analyzeSpecialistValue,
  armSummaries,
  defectKeywordHits,
  outcomeCounts,
  recovery,
  renderSpecialistValueReport,
  rowsFrom,
} from '../specialist-value/analyze.js';
import type { AgentContribution, CrewScalingRecord, CrewWidth } from '../crew-scaling/types.js';
import { crewForWidth } from '../crew-scaling/crews.js';
import { crewForArm, crewForControl } from '../specialist-value/crews.js';

/** The self-test shells out to Python; skip rather than fail where there is none. */
function hasPython(): boolean {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe('dataset F fixtures', () => {
  it('declares a defect and a reference fix that agree', () => {
    for (const f of FIXTURES) {
      const declared = new Set(f.defect.files);
      expect(Object.keys(f.referenceFix).length).toBeGreaterThan(0);
      for (const file of Object.keys(f.referenceFix)) {
        expect(declared.has(file), `${f.id}: fix touches undeclared ${file}`).toBe(true);
        // A fix has to change a file the agent can actually see.
        expect(f.files[file], `${f.id}: ${file} is not part of the repository`).toBeDefined();
        expect(f.referenceFix[file]).not.toBe(f.files[file]);
      }
      expect(f.tests.length).toBeGreaterThan(1);
      expect(f.defect.keywords.length).toBeGreaterThan(0);
    }
  });

  it('gives every fixture a distinct id and defect type coverage', () => {
    const ids = FIXTURES.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The point of the set is that the defect classes differ.
    expect(new Set(FIXTURES.map(f => f.defect.type)).size).toBe(FIXTURES.length);
    expect(fixtureById('f-api-contract')?.defect.type).toBe('api-contract');
    expect(fixtureById('nope')).toBeUndefined();
  });

  it('never tells the crew where the defect is', () => {
    for (const f of FIXTURES) {
      const { description } = prepareFixture(f, 'A', 0);
      // The listing names every file, so it singles out none of them: what
      // stays unsaid is which one is wrong, and why. Saying that would hand
      // the diagnosis over and leave the specialists nothing to do.
      for (const file of Object.keys(f.files)) {
        expect(description, `${f.id} omits ${file}`).toContain(file);
      }
      expect(description).toContain('run_tests.py');
      expect(description.toLowerCase()).not.toContain(f.defect.summary.toLowerCase().slice(0, 30));
      // No file is described differently from the others.
      for (const file of f.defect.files) {
        expect(description.split(file)).toHaveLength(2);
      }
      expect(description).toContain('Do not modify run_tests.py');
    }
  });

  it('runs prelude statements before the asserts', () => {
    const script = testScript(fixtureById('f-cross-module-state')!);
    expect(script.indexOf('register("alpha", 1)')).toBeLessThan(script.indexOf('TESTS = '));
    // Only assertions are counted, so "2/3 passed" means two assertions held.
    expect(script).toContain('"assert FIRST == [\\"alpha\\"]"');
  });

  it('restores the test file before judging a run', () => {
    const prepared = prepareFixture(fixtureById('f-edge-case')!, 'A', 9);
    const testFile = join(prepared.dir, 'run_tests.py');
    writeFileSync(testFile, 'print("ALL TESTS PASSED")\n');

    prepared.verify();

    // An agent that rewrites the suite gains nothing: it is put back first.
    expect(readFileSync(testFile, 'utf8')).toBe(testScript(prepared.fixture));
  });

  it.skipIf(!hasPython())('fails as planted and passes with the reference fix', () => {
    const checks = selfTestAll();

    for (const check of checks) {
      expect(check.failsAsPlanted, `${check.id}: ${check.notes.join('; ')}`).toBe(true);
      expect(check.passesWithReferenceFix, `${check.id}: ${check.notes.join('; ')}`).toBe(true);
      // At least one assertion holds with the defect in place, so the failing
      // suite points at something rather than being uniformly broken.
      expect(check.testsPassingWithDefect).toBeGreaterThan(0);
      expect(check.testsPassingWithDefect).toBeLessThan(check.totalTests);
      expect(check.ok).toBe(true);
    }

    expect(renderSelfTest(checks)).toContain(`${checks.length} fixture(s) usable`);
  }, 120_000);
});

// ── What the crew actually did with the task ─────────────────────────

/** An agent row shaped like the runner writes it. */
function agent(role: string, o: Partial<AgentContribution> = {}): AgentContribution {
  return {
    agentId: role.toLowerCase(),
    role,
    success: true,
    status: 'completed',
    modelCalls: 3,
    toolCalls: 2,
    costUsd: 0.002,
    tokens: 4000,
    ...o,
  };
}

function run(o: {
  arm: CrewWidth;
  workloadId?: string;
  seed?: number;
  success: boolean;
  agents: AgentContribution[];
  costUsd?: number;
}): CrewScalingRecord {
  return {
    runId: 'f-1',
    taskId: `t-${o.workloadId ?? 'f-edge-case'}-${o.arm}-${o.seed ?? 0}`,
    workloadId: o.workloadId ?? 'f-edge-case',
    crewWidth: o.arm,
    roles: [],
    seed: o.seed ?? 0,
    success: o.success,
    workflowJctMs: 30_000,
    totalCostUsd: o.costUsd ?? 0.005,
    totalTokens: 9000,
    modelCalls: 6,
    toolCalls: 4,
    modelRuntimeMs: 20_000,
    toolWaitMs: 5_000,
    activeAgents: o.agents.length,
    gateEnabled: true,
    agentResults: o.agents,
  };
}

describe('dataset F analysis', () => {
  it('separates the six things a specialist can do', () => {
    const rows = rowsFrom([
      run({ arm: 2, seed: 0, success: false, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { modelCalls: 0, toolCalls: 0, success: false, status: 'failed' }),
      ] }),
      run({ arm: 2, seed: 1, success: true, agents: [
        agent('Implementer', { verified: true, acceptedWrites: 1, proposedWrites: 1 }),
        agent('Reviewer', { verified: true, proposedWrites: 0 }),
      ] }),
      run({ arm: 2, seed: 2, success: false, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: false, toolCalls: 2, answer: 'The code looks fine to me.' }),
      ] }),
      run({ arm: 2, seed: 3, success: false, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: false, toolCalls: 3, answer: 'chunk() uses the wrong range bound, so the remainder is dropped.' }),
      ] }),
      // Replied in prose without ever opening a file.
      run({ arm: 2, seed: 6, success: false, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: false, modelCalls: 1, toolCalls: 0, answer: 'Let me start by reading the solution file.' }),
      ] }),
      run({ arm: 2, seed: 4, success: true, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: true, proposedWrites: 1, acceptedWrites: 1 }),
      ] }),
      run({ arm: 2, seed: 5, success: true, agents: [
        agent('Implementer', { verified: true, acceptedWrites: 1, proposedWrites: 1 }),
        agent('Reviewer', { verified: true, proposedWrites: 1, rolledBackWrites: 1 }),
      ] }),
    ]);

    expect(rows.map(r => r.specialists[0].outcome)).toEqual([
      'never-started',
      'abstained-nothing-to-do',
      'inspected-no-defect-found',
      'identified-not-acted',
      'no-tool-use',
      'wrote-accepted',
      'wrote-rolled-back',
    ]);
    expect(rows.every(r => r.arm === 'B')).toBe(true);
    expect(rows[3].specialists[0].namedDefect).toBe(true);
  });

  it('raises the limits for a diagnose-and-fix task without touching the roles', () => {
    const base = crewForWidth(3);
    const armC = crewForArm('C');

    expect(armC.agents.map(a => a.id)).toEqual(base.agents.map(a => a.id));
    // Same roles, same instructions, same tools — only the ceilings differ.
    expect(armC.agents.map(a => a.instructions)).toEqual(base.agents.map(a => a.instructions));
    expect(armC.agents.map(a => a.allowedTools)).toEqual(base.agents.map(a => a.allowedTools));
    expect(armC.agents.find(a => a.id === 'implementer')?.maxIterations).toBe(16);
    expect(armC.agents.find(a => a.id === 'reviewer')?.maxIterations).toBe(10);
    expect(armC.agents.every(a => a.wallTimeoutMs === 600_000)).toBe(true);
    // Dataset E's definitions are left as they were.
    expect(base.agents.find(a => a.id === 'implementer')?.maxIterations).toBe(10);
    expect(base.agents.every(a => a.wallTimeoutMs === undefined)).toBe(true);
  });

  it('changes exactly one thing in the control arm', () => {
    const armB = crewForArm('B');
    const control = crewForControl();

    // Same primary, same seat count, same ceilings, same tools — the second
    // agent's instructions are the only difference, so anything the comparison
    // shows is the role and not a fresh attempt.
    expect(control.agents).toHaveLength(armB.agents.length);
    expect(control.agents[0]).toEqual(armB.agents[0]);
    expect(control.agents[1].maxIterations).toBe(armB.agents[1].maxIterations);
    expect(control.agents[1].wallTimeoutMs).toBe(armB.agents[1].wallTimeoutMs);
    expect(control.agents[1].allowedTools).toEqual(armB.agents[0].allowedTools);
    expect(control.agents[1].instructions).toBe(armB.agents[0].instructions);
    expect(control.agents[1].instructions).not.toBe(armB.agents[1].instructions);
    // The role string is part of the prompt, so it has to match the primary's;
    // the two seats are told apart by id instead.
    expect(control.agents[1].role).toBe(armB.agents[0].role);
    expect(control.agents[1].id).not.toBe(armB.agents[0].id);
  });

  it('treats the first agent as the primary even when both are implementers', () => {
    const [row] = rowsFrom([
      run({ arm: 2, success: true, agents: [
        { ...agent('Implementer', { verified: false }), agentId: 'implementer' },
        { ...agent('Implementer', { verified: true, proposedWrites: 1, acceptedWrites: 1 }), agentId: 'implementer-2' },
      ] }),
    ]);

    expect(row.primaryLeftPassing).toBe(false);
    expect(row.specialists).toHaveLength(1);
    expect(row.specialists[0].role).toBe('Implementer (2nd)');
    expect(row.specialists[0].outcome).toBe('wrote-accepted');
  });

  it('scores naming the defect against the planted keywords', () => {
    const keywords = fixtureById('f-edge-case')!.defect.keywords;
    // One incidental word is not a diagnosis; naming two of them is evidence.
    expect(defectKeywordHits('the range is fine', keywords)).toBe(1);
    expect(defectKeywordHits('the range drops the remainder', keywords)).toBe(2);
    expect(defectKeywordHits(undefined, keywords)).toBe(0);
  });

  it('answers whether a specialist recovers a repository the implementer left broken', () => {
    const rows = rowsFrom([
      run({ arm: 2, seed: 0, success: true, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: true, proposedWrites: 1, acceptedWrites: 1 }),
      ] }),
      run({ arm: 2, seed: 1, success: false, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: false }),
      ] }),
      // Not an opportunity: the implementer had already fixed it.
      run({ arm: 2, seed: 2, success: true, agents: [
        agent('Implementer', { verified: true }),
        agent('Reviewer', { verified: true }),
      ] }),
    ]);

    const r = recovery(rows);
    expect(r.opportunities).toBe(2);
    expect(r.recovered).toBe(1);
    expect(r.recoveryRate).toBeCloseTo(0.5, 6);
    expect(r.byRole).toEqual({ Reviewer: 1 });
  });

  it('answers whether a specialist leaves a working repository alone', () => {
    const rows = rowsFrom([
      run({ arm: 2, seed: 0, success: true, agents: [
        agent('Implementer', { verified: true }), agent('Reviewer', { verified: true }),
      ] }),
      run({ arm: 2, seed: 1, success: true, agents: [
        agent('Implementer', { verified: true }),
        agent('Reviewer', { verified: true, proposedWrites: 1, rolledBackWrites: 1 }),
      ] }),
      run({ arm: 2, seed: 2, success: false, agents: [
        agent('Implementer', { verified: true }), agent('Reviewer', { proposedWrites: 1 }),
      ] }),
    ]);

    const a = abstention(rows);
    expect(a.opportunities).toBe(3);
    expect(a.safe).toBe(2);
    expect(a.regressions).toBe(1);
    expect(a.rollbacks).toBe(1);
  });

  it('pairs each arm against A on the runs they share', () => {
    const records = [
      run({ arm: 1, workloadId: 'f-edge-case', seed: 0, success: false, costUsd: 0.002, agents: [agent('Implementer')] }),
      run({ arm: 1, workloadId: 'f-api-contract', seed: 0, success: true, costUsd: 0.002, agents: [agent('Implementer')] }),
      run({ arm: 2, workloadId: 'f-edge-case', seed: 0, success: true, costUsd: 0.004, agents: [agent('Implementer'), agent('Reviewer')] }),
      run({ arm: 2, workloadId: 'f-api-contract', seed: 0, success: true, costUsd: 0.004, agents: [agent('Implementer'), agent('Reviewer')] }),
    ];
    const [a, b] = armSummaries(records);

    expect(a.arm).toBe('A');
    expect(a.successRate).toBeCloseTo(0.5, 6);
    expect(a.deltaSuccessRateVsA).toBeUndefined();
    expect(b.arm).toBe('B');
    expect(b.successRate).toBe(1);
    expect(b.deltaSuccessRateVsA).toBeCloseTo(0.5, 6);
    expect(b.deltaCostPctVsA).toBeCloseTo(100, 6);
  });

  it('reports the outcomes and the denominators it used', () => {
    const analysis = analyzeSpecialistValue([
      run({ arm: 1, seed: 0, success: false, agents: [agent('Implementer', { verified: false })] }),
      run({ arm: 2, seed: 0, success: true, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: true, proposedWrites: 1, acceptedWrites: 1 }),
      ] }),
      run({ arm: 3, seed: 0, success: false, agents: [
        agent('Implementer', { verified: false }),
        agent('Reviewer', { verified: false }),
        agent('Tester', { modelCalls: 0, toolCalls: 0 }),
      ] }),
    ], 'test');

    expect(analysis.attemptedRuns).toBe(3);
    expect(analysis.measuredRuns).toBe(3);
    expect(outcomeCounts(analysis.rows).Tester['never-started']).toBe(1);

    const report = renderSpecialistValueReport(analysis);
    expect(report).toContain('Specialist value (Dataset F)');
    expect(report).toContain('When the implementer left it failing');
    expect(report).toContain('never-started');
  });
});
