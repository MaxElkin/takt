import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  blankLine: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockResolvedValue('summarized-name'),
}));

import { error as logError, success } from '../shared/ui/index.js';
import { configureTasks } from '../features/tasks/fork/configureTasks.js';
import {
  clearCurrentTaskIfNamed,
  loadCurrentTaskName,
  resolveTaskName,
  setCurrentTaskName,
} from '../features/tasks/fork/currentTask.js';
import { saveTaskFile } from '../features/tasks/add/index.js';

const mockLogError = vi.mocked(logError);
const mockSuccess = vi.mocked(success);

let tmpDir: string;

function readConfig(): Record<string, unknown> {
  return parseYaml(
    fs.readFileSync(path.join(tmpDir, '.takt', 'config.yaml'), 'utf-8'),
  ) as Record<string, unknown>;
}

async function addTask(name: string): Promise<void> {
  await saveTaskFile(tmpDir, name, { workflow: 'default', slug: name, worktree: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-current-task-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('takt task config --current-task', () => {
  it('should write the task name as current_task', async () => {
    await addTask('kek');

    configureTasks(tmpDir, { currentTask: 'kek' });

    expect(readConfig().current_task).toBe('kek');
    expect(loadCurrentTaskName(tmpDir)).toBe('kek');
    expect(mockSuccess).toHaveBeenCalledWith('Set current_task: kek');
    expect(process.exitCode).toBeUndefined();
  });

  // A name no task answers to would fail on every later `--current`, and the
  // mistake is far easier to see at the point it is made.
  it('should refuse a name no task answers to, leaving the key untouched', async () => {
    await addTask('kek');
    configureTasks(tmpDir, { currentTask: 'kek' });
    vi.clearAllMocks();

    configureTasks(tmpDir, { currentTask: 'typo' });

    expect(readConfig().current_task).toBe('kek');
    expect(mockLogError).toHaveBeenCalledWith('Task not found: typo');
    expect(process.exitCode).toBe(1);
  });

  it('should clear the key for an empty value without checking any task', () => {
    setCurrentTaskName(tmpDir, 'gone');

    configureTasks(tmpDir, { currentTask: '' });

    expect(readConfig().current_task).toBeUndefined();
    expect(mockSuccess).toHaveBeenCalledWith('Cleared current_task.');
    expect(process.exitCode).toBeUndefined();
  });

  it('should report both task-scoped keys when given no options', () => {
    configureTasks(tmpDir, {});

    expect(process.exitCode).toBeUndefined();
    expect(readConfig).toThrow(); // nothing was written
  });
});

describe('resolveTaskName', () => {
  it('should take --name as given', () => {
    expect(resolveTaskName(tmpDir, { name: '  kek  ' })).toEqual({ name: 'kek' });
    expect(process.exitCode).toBeUndefined();
  });

  it('should resolve --current through the config key', () => {
    setCurrentTaskName(tmpDir, 'kek');

    expect(resolveTaskName(tmpDir, { current: true })).toEqual({ name: 'kek' });
  });

  // The two are alternatives, not a fallback chain: silently preferring one
  // would act on a task the caller did not mean to name.
  it('should refuse both options together', () => {
    setCurrentTaskName(tmpDir, 'kek');

    expect(resolveTaskName(tmpDir, { name: 'other', current: true })).toEqual({ failed: true });
    expect(mockLogError).toHaveBeenCalledWith('Pass either --name or --current, not both.');
    expect(process.exitCode).toBe(1);
  });

  it('should refuse neither option', () => {
    expect(resolveTaskName(tmpDir, {})).toEqual({ failed: true });
    expect(mockLogError).toHaveBeenCalledWith(
      "Missing required option '--name <name>' (or --current).",
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['no current task is configured', undefined],
    ['the configured value is blank', '   '],
  ])('should refuse --current when %s', (_case, configured) => {
    if (configured !== undefined) {
      setCurrentTaskName(tmpDir, configured);
    }

    expect(resolveTaskName(tmpDir, { current: true })).toEqual({ failed: true });
    expect(mockLogError).toHaveBeenCalledWith(
      'No current task is set. Use `takt task config --current-task <name>`.',
    );
    expect(process.exitCode).toBe(1);
  });
});

describe('clearCurrentTaskIfNamed', () => {
  it('should clear the key when it names the deleted task', () => {
    setCurrentTaskName(tmpDir, 'kek');

    clearCurrentTaskIfNamed(tmpDir, 'kek');

    expect(loadCurrentTaskName(tmpDir)).toBeUndefined();
  });

  it('should leave a key that names a different task alone', () => {
    setCurrentTaskName(tmpDir, 'kek');

    clearCurrentTaskIfNamed(tmpDir, 'other');

    expect(loadCurrentTaskName(tmpDir)).toBe('kek');
  });
});
