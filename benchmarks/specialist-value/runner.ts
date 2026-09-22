/**
 * Dataset F: does a specialist add verified value on a task that needs
 * diagnosing?
 *
 * Three arms over the same repositories, the same model, the same per-agent
 * budget, the same tools and the same number of repetitions:
 *
 *   A  implementer
 *   B  implementer + reviewer
 *   C  implementer + reviewer + tester
 *
 * These are the crew-scaling widths 1, 2 and 3 — the researcher is deliberately
 * left out, since Dataset E showed that role is advisory by construction and
 * would blur the question. The crew execution, the records and the verified-edit
 * gate are the ones the crew-scaling runner already uses; only the workloads
 * differ.
 */

import { FIXTURES, fixtureById, type Fixture } from './fixtures.js';
import { ARMS, ARM_WIDTH, armOfWidth, prepareFixture, type Arm } from './tasks.js';
import { runCrewScaling, type ScalingWorkload } from '../crew-scaling/runner.js';
import { comparisonCrew, COMPARISON_ARMS, crewForArm, crewForControl, type ComparisonArm } from './crews.js';
import { join } from 'node:path';
import type { CrewScalingRecord, CrewWidth } from '../crew-scaling/types.js';

/** Fixtures, as workloads the crew-scaling runner can execute. */
export function fixtureWorkloads(
  fixtures: readonly Fixture[] = FIXTURES,
  slot?: string,
): ScalingWorkload[] {
  return fixtures.map(fixture => ({
    workloadId: fixture.id,
    prepare: (width: CrewWidth, seed: number) => prepareFixture(fixture, slot ?? armOfWidth(width) ?? 'A', seed),
  }));
}

export interface ComparisonOptions {
  /** Fixtures to run; defaults to Dataset F's set */
  fixtures?: readonly Fixture[];
  fixtureIds?: string[];
  /** Repetitions per (fixture, arm) */
  seeds?: number;
  arms?: ComparisonArm[];
  provider: string;
  model: string;
  /** Each arm writes runs.jsonl into its own subdirectory of this one */
  outDir: string;
  label: string;
}

/**
 * The staged-recovery comparison: the same repositories and repetitions run by
 * the implementer alone, by the full crew every time, and by the staged crew
 * that escalates only where verification fails.
 *
 * Each arm is a separate invocation of the same runner with the same workloads,
 * model, budget mode, gate policy and tools — the crew definition is the only
 * thing that changes, and the three crews share their agent definitions.
 */
export async function runStagedComparison(
  opts: ComparisonOptions,
): Promise<Array<{ arm: ComparisonArm; records: CrewScalingRecord[] }>> {
  const available = opts.fixtures ?? FIXTURES;
  const fixtures = opts.fixtureIds && opts.fixtureIds.length > 0
    ? opts.fixtureIds.map(id => {
      const found = available.find(f => f.id === id) ?? fixtureById(id);
      if (!found) throw new Error(`Unknown fixture: ${id}`);
      return found;
    })
    : available;

  const out: Array<{ arm: ComparisonArm; records: CrewScalingRecord[] }> = [];
  for (const arm of opts.arms && opts.arms.length > 0 ? opts.arms : COMPARISON_ARMS) {
    process.stderr.write(`\n--- arm ${arm} ---\n`);
    const records = await runCrewScaling({
      workloads: fixtureWorkloads(fixtures, arm),
      crewFactory: () => comparisonCrew(arm),
      // One crew per arm, so the width loop runs once.
      widths: [1],
      tasks: fixtures.length,
      offset: 0,
      seeds: opts.seeds ?? 3,
      verifiedEdit: true,
      provider: opts.provider,
      model: opts.model,
      outDir: join(opts.outDir, arm),
      label: `${opts.label}-${arm}`,
    });
    out.push({ arm, records });
  }
  return out;
}

export interface SpecialistRunOptions {
  /** Defaults to every fixture */
  fixtureIds?: string[];
  /** Defaults to A, B and C */
  arms?: Arm[];
  /**
   * Run arm B's control instead of the arms: a second implementer in the
   * reviewer's seat, to tell the role apart from a fresh second attempt.
   */
  control?: boolean;
  /** Repetitions per (fixture, arm). Three from the start: E2 earned that lesson. */
  seeds?: number;
  provider: string;
  model: string;
  outDir: string;
  label: string;
}

export async function runSpecialistValue(opts: SpecialistRunOptions): Promise<CrewScalingRecord[]> {
  const fixtures = opts.fixtureIds && opts.fixtureIds.length > 0
    ? opts.fixtureIds.map(id => {
      const found = fixtureById(id);
      if (!found) throw new Error(`Unknown fixture: ${id}`);
      return found;
    })
    : FIXTURES;

  const arms = opts.control ? ['B' as Arm] : (opts.arms && opts.arms.length > 0 ? opts.arms : ARMS);

  return runCrewScaling({
    workloads: fixtureWorkloads(fixtures),
    crewFactory: opts.control
      ? () => crewForControl()
      : (width: CrewWidth) => crewForArm(armOfWidth(width) ?? 'A'),
    widths: arms.map(a => ARM_WIDTH[a]),
    // The workloads are supplied directly, so the MBPP selectors are unused.
    tasks: fixtures.length,
    offset: 0,
    seeds: opts.seeds ?? 3,
    // Always on: a specialist that breaks a repaired repository is exactly the
    // behaviour this experiment is measuring, and it must be recorded rather
    // than allowed to stand.
    verifiedEdit: true,
    provider: opts.provider,
    model: opts.model,
    outDir: opts.outDir,
    label: opts.label,
  });
}
