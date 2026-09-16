import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockListAllTaskItems = vi.fn();
const mockFailInterruptedRunningTasks = vi.fn(() => 0);
const mockRestartTaskFromBeginning = vi.fn();
const mockResumeFailedTask = vi.fn();
const mockStartPendingTask = vi.fn();

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    listAllTaskItems(): unknown[] {
      return mockListAllTaskItems();
    }

    failInterruptedRunningTasks(): number {
      return mockFailInterruptedRunningTasks();
    }
  },
}));

vi.mock('../features/tasks/restart/restartActions.js', () => ({
  restartTaskFromBeginning: (...args: unknown[]) => mockRestartTaskFromBeginning(...args),
  resumeFailedTask: (...args: unknown[]) => mockResumeFailedTask(...args),
  startPendingTask: (...args: unknown[]) => mockStartPendingTask(...args),
}));

import { restartTask, resumeTask } from '../features/tasks/restart/index.js';

describe('restartTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restarts the failed task whose name matches exactly', async () => {
    const task = { name: 'task with spaces', kind: 'failed' };
    mockListAllTaskItems.mockReturnValue([
      { name: 'task with spaces-extra', kind: 'failed' },
      task,
    ]);
    mockRestartTaskFromBeginning.mockResolvedValue(true);

    await expect(restartTask('/project', 'task with spaces')).resolves.toBe(true);
    expect(mockRestartTaskFromBeginning).toHaveBeenCalledWith(task, '/project', undefined);
  });

  it('restarts a completed task from the beginning', async () => {
    const task = { name: 'completed-task', kind: 'completed' };
    mockListAllTaskItems.mockReturnValue([task]);
    mockRestartTaskFromBeginning.mockResolvedValue(true);

    await expect(restartTask('/project', 'completed-task')).resolves.toBe(true);
    expect(mockRestartTaskFromBeginning).toHaveBeenCalledWith(task, '/project', undefined);
  });

  it('heals interrupted running tasks before reading the list', async () => {
    const task = { name: 'killed-task', kind: 'failed' };
    mockListAllTaskItems.mockReturnValue([task]);
    mockRestartTaskFromBeginning.mockResolvedValue(true);

    await restartTask('/project', 'killed-task');

    expect(mockFailInterruptedRunningTasks).toHaveBeenCalled();
  });

  it.each([
    ['restart', restartTask],
    ['resume', resumeTask],
  ] as const)('starts a pending task from %s', async (_label, run) => {
    const task = { name: 'pending-task', kind: 'pending' };
    mockListAllTaskItems.mockReturnValue([task]);
    mockStartPendingTask.mockResolvedValue(true);

    await expect(run('/project', 'pending-task')).resolves.toBe(true);
    expect(mockStartPendingTask).toHaveBeenCalledWith(task, '/project', undefined);
    expect(mockRestartTaskFromBeginning).not.toHaveBeenCalled();
    expect(mockResumeFailedTask).not.toHaveBeenCalled();
  });

  it('rejects a task that is not failed', async () => {
    mockListAllTaskItems.mockReturnValue([{ name: 'still-running', kind: 'running' }]);


    await expect(restartTask('/project', 'still-running')).rejects.toThrow(
      'cannot be restarted because its status is running',
    );
    expect(mockRestartTaskFromBeginning).not.toHaveBeenCalled();
  });

  it('reports an unknown task name', async () => {
    mockListAllTaskItems.mockReturnValue([{ name: 'another-task', kind: 'failed' }]);

    await expect(restartTask('/project', 'missing-task')).rejects.toThrow(
      'Task not found: missing-task',
    );
    expect(mockRestartTaskFromBeginning).not.toHaveBeenCalled();
  });

  it('resumes the failed task whose name matches exactly', async () => {
    const task = { name: 'failed-task', kind: 'failed' };
    mockListAllTaskItems.mockReturnValue([task]);
    mockResumeFailedTask.mockResolvedValue(true);

    await expect(resumeTask('/project', 'failed-task')).resolves.toBe(true);
    expect(mockResumeFailedTask).toHaveBeenCalledWith(task, '/project', undefined);
  });

  it('does not resume a completed task', async () => {
    mockListAllTaskItems.mockReturnValue([{ name: 'completed-task', kind: 'completed' }]);

    await expect(resumeTask('/project', 'completed-task')).rejects.toThrow(
      'cannot be resumed because its status is completed',
    );
    expect(mockResumeFailedTask).not.toHaveBeenCalled();
  });
});
