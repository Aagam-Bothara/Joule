import { describe, expect, it } from 'vitest';
import { checkPythonEdit, editRepoFile, writeRepoFile } from '../harness/workloads/repo-python-guard.js';

describe('container Python edit guard', () => {
  it('restores the previous source when an edit creates the observed syntax error', () => {
    const before = 'def _is_ignored_file(element: str):\n    return False\n';
    let current = 'def _is_ignored_file(\n    pass\n    element: str,\n';
    const commands: string[] = [];
    const run = (command: string, _timeoutMs: number, input?: string) => {
      commands.push(command);
      if (command.startsWith('python -m py_compile')) {
        return { status: 1, stdout: '', stderr: 'SyntaxError: invalid syntax (expand_modules.py, line 47)' };
      }
      if (command.startsWith('cat >')) {
        current = input ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    };

    expect(() => checkPythonEdit('pylint/lint/expand_modules.py', before, run))
      .toThrow('SyntaxError: invalid syntax');
    expect(current).toBe(before);
    expect(commands).toEqual([
      "python -m py_compile 'pylint/lint/expand_modules.py'",
      "cat > 'pylint/lint/expand_modules.py'",
    ]);
  });

  it('removes a newly created Python file when its syntax is invalid', () => {
    let exists = true;
    const run = (command: string) => {
      if (command.startsWith('python -m py_compile')) return { status: 1, stdout: '', stderr: 'SyntaxError: invalid syntax' };
      if (command.startsWith('rm -f')) {
        exists = false;
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    };

    expect(() => checkPythonEdit('new_module.py', null, run)).toThrow('edit rolled back');
    expect(exists).toBe(false);
  });

  it('keeps syntactically valid Python without restoring it', () => {
    const commands: string[] = [];
    const run = (command: string) => {
      commands.push(command);
      return { status: 0, stdout: '', stderr: '' };
    };

    expect(() => checkPythonEdit('module.py', 'old', run)).not.toThrow();
    expect(commands).toEqual(["python -m py_compile 'module.py'"]);
  });

  it('does not run Python checks for other file types', () => {
    const run = () => { throw new Error('should not run'); };
    expect(() => checkPythonEdit('README.md', 'old', run)).not.toThrow();
  });
});

describe('repository write tools', () => {
  const before = 'def helper():\n    return 1\n';
  const invalid = 'def helper(\n    return 2\n';

  function fakeRepo(initial: string | null) {
    let current = initial;
    const commands: string[] = [];
    const run = (command: string, _timeoutMs = 300_000, input?: string) => {
      commands.push(command);
      if (command.startsWith('cat >') || command.includes('&& cat >')) {
        current = input ?? '';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('cat ')) {
        return current === null
          ? { status: 1, stdout: '', stderr: 'No such file' }
          : { status: 0, stdout: current, stderr: '' };
      }
      if (command.startsWith('python -m py_compile')) {
        return current === invalid
          ? { status: 1, stdout: '', stderr: 'SyntaxError: invalid syntax (module.py, line 1)' }
          : { status: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('rm -f')) {
        current = null;
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    };
    return { run, commands, current: () => current };
  }

  it('rolls back an invalid repo_write on an existing Python file', () => {
    const repo = fakeRepo(before);
    expect(() => writeRepoFile('module.py', invalid, repo.run)).toThrow('edit rolled back');
    expect(repo.current()).toBe(before);
    expect(repo.commands).toContain("python -m py_compile 'module.py'");
  });

  it('rolls back an invalid repo_edit on an existing Python file', () => {
    const repo = fakeRepo(before);
    expect(() => editRepoFile('module.py', before, invalid, repo.run)).toThrow('edit rolled back');
    expect(repo.current()).toBe(before);
    expect(repo.commands).toContain("python -m py_compile 'module.py'");
  });

  it('removes an invalid newly created Python file', () => {
    const repo = fakeRepo(null);
    expect(() => writeRepoFile('module.py', invalid, repo.run)).toThrow('edit rolled back');
    expect(repo.current()).toBeNull();
  });

  it('keeps a valid Python write and edit', () => {
    const repo = fakeRepo(before);
    const afterWrite = 'def helper():\n    return 2\n';
    writeRepoFile('module.py', afterWrite, repo.run);
    expect(repo.current()).toBe(afterWrite);
    const edited = editRepoFile('module.py', 'return 2', 'return 3', repo.run);
    expect(edited).toEqual({ content: 'def helper():\n    return 3\n', line: 2 });
    expect(repo.current()).toBe(edited.content);
  });

  it('does not overwrite a Python file if its previous content cannot be inspected', () => {
    const commands: string[] = [];
    const run = (command: string) => {
      commands.push(command);
      return { status: 1, stdout: '', stderr: 'Permission denied' };
    };
    expect(() => writeRepoFile('module.py', invalid, run)).toThrow('cannot inspect');
    expect(commands).toEqual(["cat 'module.py'"]);
  });
});
