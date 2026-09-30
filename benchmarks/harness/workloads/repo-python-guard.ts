export interface RepoCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type RepoCommand = (command: string, timeoutMs: number, input?: string) => RepoCommandResult;

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const isPython = (path: string): boolean => /\.pyi?$/i.test(path);

/** Keep Python files parseable after each container-side write. */
export function checkPythonEdit(path: string, before: string | null, run: RepoCommand): void {
  if (!isPython(path)) return;
  const quoted = quote(path);
  const check = run(`python -m py_compile ${quoted}`, 30_000);
  if (check.status === 0) return;

  const restore = before === null
    ? run(`rm -f ${quoted}`, 30_000)
    : run(`cat > ${quoted}`, 30_000, before);
  if (restore.status !== 0) {
    throw new Error(`Python syntax check failed and rollback failed for ${path}: ${restore.stderr.trim().slice(-300)}`);
  }

  const evidence = (check.stderr || check.stdout).trim().slice(-400) || 'Python could not compile the file';
  throw new Error(`Python syntax check failed; edit rolled back: ${evidence}`);
}

/** Write through the container, restoring a Python file if it no longer parses. */
export function writeRepoFile(path: string, content: string, run: RepoCommand): void {
  let before: string | null = null;
  if (isPython(path)) {
    const prior = run(`cat ${quote(path)}`, 60_000);
    if (prior.status === 0) before = prior.stdout;
    else if (!/no such file|not found/i.test(prior.stderr)) {
      throw new Error(`cannot inspect ${path} before write: ${prior.stderr.trim().slice(0, 200)}`);
    }
  }

  const quoted = quote(path);
  const written = run(`mkdir -p "$(dirname ${quoted})" && cat > ${quoted}`, 60_000, content);
  if (written.status !== 0) throw new Error(`write failed: ${written.stderr.trim().slice(0, 200)}`);
  checkPythonEdit(path, before, run);
}

/** Replace one exact block, then check and restore Python syntax if needed. */
export function editRepoFile(path: string, searchText: string, replacement: string, run: RepoCommand): { content: string; line: number } {
  const current = run(`cat ${quote(path)}`, 60_000);
  if (current.status !== 0) throw new Error(`cannot read ${path}: ${current.stderr.trim().slice(0, 200) || 'no such file'}`);
  const before = current.stdout;
  let search = searchText;
  let index = before.indexOf(search);
  if (index < 0) {
    search = searchText.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');
    index = before.indexOf(search);
  }
  if (index < 0) throw new Error(`search text not found in ${path}; read the file and copy the block exactly`);
  if (before.indexOf(search, index + 1) >= 0) throw new Error(`search text occurs more than once in ${path}; include more surrounding lines`);

  const content = before.slice(0, index) + replacement + before.slice(index + search.length);
  const written = run(`cat > ${quote(path)}`, 60_000, content);
  if (written.status !== 0) throw new Error(`write failed: ${written.stderr.trim().slice(0, 200)}`);
  checkPythonEdit(path, before, run);
  return { content, line: before.slice(0, index).split('\n').length };
}
