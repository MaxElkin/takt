import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { printTaskTable } from '../features/tasks/fork/printTaskTable.js';

const mockInfo = vi.fn();
vi.mock('../shared/ui/index.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
}));

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-task-list-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeTasksFile(projectDir: string): void {
  const tasksFile = path.join(projectDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({
    tasks: [
      {
        name: 'pending-task',
        status: 'pending',
        content: 'Pending content',
        workflow: 'workflow-alpha',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: null,
        completed_at: null,
      },
      {
        name: 'failed-task',
        status: 'failed',
        content: 'Failed content',
        created_at: '2026-02-09T00:00:00.000Z',
        started_at: '2026-02-09T00:01:00.000Z',
        completed_at: '2026-02-09T00:02:00.000Z',
        failure: { step: 'review', error: 'Boom' },
      },
    ],
  }), 'utf-8');
}

function writeCurrentTask(projectDir: string, name: string): void {
  const configFile = path.join(projectDir, '.takt', 'config.yaml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, stringifyYaml({ current_task: name }), 'utf-8');
}

describe('printTaskTable', () => {
  it('should print a padded name, status and workflow table', () => {
    writeTasksFile(tmpDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskTable(tmpDir);

    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      'NAME          STATUS   WORKFLOW',
      'pending-task  pending  workflow-alpha',
      'failed-task   failed   -',
    ]);
  });

  // The same glyph `takt task tree` marks the current step with, so the list
  // answers "which one is --current" without a second command.
  it('should mark the task --current resolves to', () => {
    writeTasksFile(tmpDir);
    writeCurrentTask(tmpDir, 'pending-task');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskTable(tmpDir);

    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      'NAME          STATUS   WORKFLOW',
      'pending-task  pending  workflow-alpha  ◀ current',
      'failed-task   failed   -',
    ]);
  });

  // The stale key is reported when something tries to act on it; a list that
  // refused to print would be a poor way to find that out.
  it('should mark nothing when current_task names no task', () => {
    writeTasksFile(tmpDir);
    writeCurrentTask(tmpDir, 'long-gone');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskTable(tmpDir);

    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      'NAME          STATUS   WORKFLOW',
      'pending-task  pending  workflow-alpha',
      'failed-task   failed   -',
    ]);
  });

  it('should report when there are no tasks', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    printTaskTable(tmpDir);

    expect(logSpy).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith('No tasks to list.');
  });
});
