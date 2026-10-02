/**
 * The verified-edit gate's view of a repository inside a container.
 *
 * The repo_write / repo_edit tools change files in the container, so a gate
 * that snapshots host paths protects nothing: it reads "missing" before the
 * write and has nothing to put back after a regression. This workspace reads
 * and restores the same files the tools change, through the same command
 * runner, with the same path handling (relative to /testbed, a leading
 * /testbed/ stripped).
 *
 * Content travels as UTF-8 text, as it does for the tools themselves.
 */

import type { EditWorkspace } from '@joule/shared';
import { quote, type RepoCommand } from './repo-python-guard.js';

/** Exit status the read command uses for "no such file", distinct from any failure. */
const MISSING = 44;

const repoPath = (path: string): string => path.replace(/^\/testbed\//, '');

export function containerWorkspace(run: RepoCommand): EditWorkspace {
  return {
    read(path) {
      const p = quote(repoPath(path));
      const r = run(`if [ -e ${p} ]; then cat ${p}; else exit ${MISSING}; fi`, 60_000);
      if (r.status === MISSING) return null;
      if (r.status !== 0) throw new Error(`cannot snapshot ${repoPath(path)}: ${r.stderr.trim().slice(0, 200) || `exit ${r.status}`}`);
      return r.stdout;
    },
    write(path, content) {
      const p = quote(repoPath(path));
      const r = run(`mkdir -p "$(dirname ${p})" && cat > ${p}`, 60_000, content);
      if (r.status !== 0) throw new Error(`cannot restore ${repoPath(path)}: ${r.stderr.trim().slice(0, 200) || `exit ${r.status}`}`);
    },
    remove(path) {
      const r = run(`rm -f ${quote(repoPath(path))}`, 60_000);
      if (r.status !== 0) throw new Error(`cannot remove ${repoPath(path)}: ${r.stderr.trim().slice(0, 200) || `exit ${r.status}`}`);
    },
  };
}
