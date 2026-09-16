import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

const mockDeleteBranch = vi.fn();
vi.mock('../features/tasks/list/taskActions.js', () => ({
  deleteBranch: (...args: unknown[]) => mockDeleteBranch(...args),
}));

import { confirm } from '../shared/prompt/index.js';
import { info, error as logError } from '../shared/ui/index.js';
import { deleteNamedTask } from '../features/tasks/fork/deleteNamedTask.js';

const mockConfirm = vi.mocked(confirm);
const mockInfo = vi.mocked(info);
const mockLogError = vi.mocked(logError);

let tmpDir: string;

function setupTasksFile(projectDir: string): string {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name: 'pending-task',
        status: 'pending',
        content: 'pending',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
      {
        name: 'completed-task',
        status: 'completed',
        content: 'completed',
        branch: 'takt/completed-task',
        worktree_path: '/tmp/takt/completed-task',
        created_at: '2025-01-15T00:00:00.000Z',
        started_at: '2025-01-15T00:01:00.000Z',
        completed_at: '2025-01-15T00:02:00.000Z',
      },
    ],
  }), 'utf-8');
  return tasksFile;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteBranch.mockReturnValue(true);
  mockConfirm.mockResolvedValue(true);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-task-delete-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('deleteNamedTask', () => {
  it('should delete the task with that exact name after confirmation', async () => {
    const tasksFile = setupTasksFile(tmpDir);

    await deleteNamedTask(tmpDir, 'pending-task');

    expect(mockConfirm).toHaveBeenCalledWith('Delete pending task "pending-task"?', false);
    expect(mockDeleteBranch).not.toHaveBeenCalled();
    expect(fs.readFileSync(tasksFile, 'utf-8')).not.toContain('pending-task');
    expect(process.exitCode).toBeUndefined();
  });

  it('should keep the task when confirmation is declined', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    const before = fs.readFileSync(tasksFile, 'utf-8');
    mockConfirm.mockResolvedValue(false);

    await deleteNamedTask(tmpDir, 'pending-task');

    expect(mockInfo).toHaveBeenCalledWith('Cancelled.');
    expect(fs.readFileSync(tasksFile, 'utf-8')).toBe(before);
    expect(process.exitCode).toBeUndefined();
  });

  it('should clean up the branch of a task that has one', async () => {
    const tasksFile = setupTasksFile(tmpDir);

    await deleteNamedTask(tmpDir, 'completed-task');

    expect(mockDeleteBranch).toHaveBeenCalledWith(tmpDir, expect.objectContaining({ name: 'completed-task' }));
    expect(fs.readFileSync(tasksFile, 'utf-8')).not.toContain('completed-task');
  });

  it.each([
    ['a missing name', undefined, "Missing required option '--name <name>'."],
    ['a blank name', '  ', "Missing required option '--name <name>'."],
    ['an unknown name', 'pending', 'Task not found: pending'],
  ])('should fail without deleting for %s', async (_case, name, message) => {
    const tasksFile = setupTasksFile(tmpDir);
    const before = fs.readFileSync(tasksFile, 'utf-8');

    await deleteNamedTask(tmpDir, name);

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(tasksFile, 'utf-8')).toBe(before);
  });

  it('should name the runs and the task directory, then delete them', async () => {
    const tasksFile = path.join(tmpDir, '.takt', 'tasks.yaml');
    const taskDir = '.takt/tasks/20260916-101431-with-runs';
    fs.mkdirSync(path.join(tmpDir, taskDir), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, taskDir, 'order.md'), 'order', 'utf-8');
    for (const [slug, source] of [['run-a', undefined], ['run-b', 'run-a']] as const) {
      const runRoot = path.join(tmpDir, '.takt', 'runs', slug);
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(path.join(runRoot, 'meta.json'), JSON.stringify({
        task: 'with runs',
        workflow: 'probe',
        runSlug: slug,
        runRoot: `.takt/runs/${slug}`,
        reportDirectory: `.takt/runs/${slug}/reports`,
        contextDirectory: `.takt/runs/${slug}/context`,
        logsDirectory: `.takt/runs/${slug}/logs`,
        status: 'failed',
        startTime: '2026-09-16T09:00:00.000Z',
        task_dir: taskDir,
        ...(source === undefined ? {} : { source_run_slug: source }),
      }), 'utf-8');
    }
    fs.writeFileSync(tasksFile, stringifyYaml({
      tasks: [{
        name: 'with-runs',
        status: 'failed',
        task_dir: taskDir,
        run_slug: 'run-b',
        failure: { error: 'probe failed' },
        created_at: '2026-09-16T09:00:00.000Z',
        started_at: '2026-09-16T09:00:01.000Z',
        completed_at: '2026-09-16T09:00:02.000Z',
      }],
    }), 'utf-8');

    await deleteNamedTask(tmpDir, 'with-runs');

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Delete failed task "with-runs" and its 2 runs \(\d+ B\) and its task directory\?$/,
      ),
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, '.takt', 'runs', 'run-a'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.takt', 'runs', 'run-b'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, taskDir))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('should fail and keep the record when branch cleanup fails', async () => {
    const tasksFile = setupTasksFile(tmpDir);
    mockDeleteBranch.mockReturnValue(false);

    await deleteNamedTask(tmpDir, 'completed-task');

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(tasksFile, 'utf-8')).toContain('completed-task');
  });
});
