/**
 * What an agent sees, pinned before the 2026-10-02 amendment (commit ff01479).
 *
 * The amendment adds reporting only: secondary regression scores, a diff
 * audit, end-reason strata and cost. None of it may reach an agent. These
 * values were captured from the code at ff01479 and must not move: the task
 * text and check label for a development and a Django item, the labels of
 * every check mode, and the crew definitions (prompts and allowances).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gatePolicy } from '../crew-scaling/tasks.js';
import { CHECK_LABELS } from '../real-repo/checks.js';
import { REPRO_AUTHOR, SWE_AGENTS, singleAgentCrew, sweCrew } from '../real-repo/crews.js';
import { loadInstances, prepareInstance } from '../real-repo/workload.js';
import { DJANGO_ITEM, ITEM, fakeDocker } from './real-repo-fixtures.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'joule-rr-view-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

const INTRO = (repo: string, issue: string) => [
  `Repository: ${repo} (a working copy is checked out at /testbed inside this environment)`,
  '',
  'Reported issue:',
  issue,
  '',
  'Fix the repository so the issue is resolved. Use repo_read to read files, repo_write to change them,',
  'and repo_shell to run commands (for example to search the tree or run tests). Paths are relative to /testbed.',
  'Change the source, not the tests.',
].join('\n');
const DJANGO_HINT = 'Tests: this is the Django source tree (no manage.py, no pytest). Run a test module with: python tests/runtests.py --settings=test_sqlite --parallel 1 <module>, e.g. python tests/runtests.py --settings=test_sqlite --parallel 1 admin_views.test_adminsite (module = path under tests/ with dots).';
const PYTEST_HINT = 'Tests: run a test file with: python -m pytest -x -q path/to/test_x.py';

const EXPECTED = {
  [`${ITEM.instance_id}/oracle`]: {
    description: INTRO('pytest-dev/pytest', 'Something is broken.'),
    verifyLabel: "the repository's check",
  },
  [`${ITEM.instance_id}/visible-f2p`]: {
    description: [
      INTRO('pytest-dev/pytest', 'Something is broken.'),
      '',
      'These tests fail now and must pass once the issue is fixed. They are already in the repository; do not change them:',
      '- testing/test_existing.py::test_hidden_regression',
      'They are in: testing/test_existing.py, testing/test_added.py',
      PYTEST_HINT,
    ].join('\n'),
    verifyLabel: 'the failing tests named in the task',
  },
  [`${DJANGO_ITEM.instance_id}/oracle`]: {
    description: `${INTRO('django/django', 'QuerySet does the wrong thing')}\n${DJANGO_HINT}`,
    verifyLabel: "the repository's check",
  },
  [`${DJANGO_ITEM.instance_id}/visible-f2p`]: {
    description: [
      `${INTRO('django/django', 'QuerySet does the wrong thing')}\n${DJANGO_HINT}`,
      '',
      'These tests fail now and must pass once the issue is fixed. They are already in the repository; do not change them:',
      '- test_new (queries.tests.Q)',
      'They are in: tests/queries/tests.py, tests/admin_views/test_adminsite.py',
    ].join('\n'),
    verifyLabel: 'the failing tests named in the task',
  },
};

describe('what an agent sees is unchanged by the amendment', () => {
  for (const item of [ITEM, DJANGO_ITEM]) {
    for (const mode of ['oracle', 'visible-f2p'] as const) {
      it(`task text and check label: ${item.repo}, ${mode}`, () => {
        const prepared = prepareInstance(item, 'unit', { docker: fakeDocker().run, root, mode });
        const want = EXPECTED[`${item.instance_id}/${mode}`];
        expect(prepared.description).toBe(want.description);
        expect(prepared.verifyLabel).toBe(want.verifyLabel);
        expect(gatePolicy(prepared).label).toBe(want.verifyLabel);
      });
    }
  }

  it('check labels for every mode', () => {
    expect(CHECK_LABELS).toEqual({
      oracle: "the repository's check",
      repro: "the issue's reproduction test and the existing tests for the modules you changed",
      'visible-f2p': 'the failing tests named in the task',
    });
  });

  it('crew prompts and allowances', () => {
    const h = (v: unknown) => sha(JSON.stringify(v));
    expect(h(SWE_AGENTS)).toBe('7015f05ed973cc2508c5dee06b7c40d96abb45770a387639f855a3ae3dfdc8ef');
    expect(h(REPRO_AUTHOR)).toBe('d09af93cf0c307d284c8e29737f03937c6b04a0e60330659926d121c9ec14e80');
    expect(h(sweCrew('staged'))).toBe('c087c1cb00ab10e33752f5b224ec8c11fdeb15282b13f52a4a72261e140f7fc9');
    expect(h(singleAgentCrew(SWE_AGENTS.implementer, 'x'))).toBe('2dea97112117476c7981c0a586d71de5fb07ceb220707790141b1ad2ca03c05d');
  });

  // The real issues (benchmarks/data is gitignored, so this runs where the data is).
  const data = existsSync(resolve('benchmarks/data/swebench-lite.json'));
  const REAL: Record<string, { sha256: string; length: number; verifyLabel: string }> = {
    'pallets__flask-4045/oracle': { sha256: '74c3d3d85dd0bcb0115cb3b13f638e71d9264546f247e18255bc73532c345d1e', length: 587, verifyLabel: "the repository's check" },
    'pallets__flask-4045/visible-f2p': { sha256: '42a0d40540f26ca2b8ccf447778e11cb6bb91388fbb0f7aa2d1b36af63311b9a', length: 965, verifyLabel: 'the failing tests named in the task' },
    'pytest-dev__pytest-7432/oracle': { sha256: 'e6f97cd922f4cd2b53614f710782ceb582e22599a7816e12161a340930371940', length: 1134, verifyLabel: "the repository's check" },
    'pytest-dev__pytest-7432/visible-f2p': { sha256: 'f491d9569606bf7291672ba2a704338ccb11513e0beb281395e87c5540216514', length: 1451, verifyLabel: 'the failing tests named in the task' },
    'django__django-10914/oracle': { sha256: 'a1b18b43d3ee9d2f95d2ca23e2eb5f78baaa0232e30a13a8cbb887bd73397852', length: 1671, verifyLabel: "the repository's check" },
    'django__django-10914/visible-f2p': { sha256: 'c01c8273635a8f5b0ec33f937fa55ab6f19208c1cce8c3bd4fdd54b1828e515b', length: 1908, verifyLabel: 'the failing tests named in the task' },
  };
  it.skipIf(!data)('task text for real dev and held-out issues (hashes)', () => {
    const byId = new Map(loadInstances().map(i => [i.instance_id, i]));
    for (const [key, want] of Object.entries(REAL)) {
      const [id, mode] = key.split('/') as [string, 'oracle' | 'visible-f2p'];
      const prepared = prepareInstance(byId.get(id)!, 'unit', { docker: fakeDocker().run, root, mode });
      expect({ key, sha256: sha(prepared.description), length: prepared.description.length, verifyLabel: prepared.verifyLabel })
        .toEqual({ key, ...want });
    }
  });
});
