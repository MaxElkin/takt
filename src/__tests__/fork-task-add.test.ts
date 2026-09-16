import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

vi.mock('../shared/prompt/index.js', () => ({
  promptInput: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  success: vi.fn(),
  info: vi.fn(),
  blankLine: vi.fn(),
  error: vi.fn(),
  withProgress: vi.fn(async (_start, _done, operation) => operation()),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../features/tasks/execute/selectAndExecute.js', () => ({
  determineWorkflow: vi.fn(),
}));

vi.mock('../infra/task/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  summarizeTaskName: vi.fn().mockResolvedValue('summarized-name'),
}));

import { promptInput, confirm } from '../shared/prompt/index.js';
import { error } from '../shared/ui/index.js';
import { determineWorkflow } from '../features/tasks/execute/selectAndExecute.js';
import { summarizeTaskName } from '../infra/task/index.js';
import { addNamedTask } from '../features/tasks/fork/addNamedTask.js';

const mockPromptInput = vi.mocked(promptInput);
const mockConfirm = vi.mocked(confirm);
const mockError = vi.mocked(error);
const mockDetermineWorkflow = vi.mocked(determineWorkflow);

let testDir: string;

function loadTasks(dir: string): { tasks: Array<Record<string, unknown>> } {
  const raw = fs.readFileSync(path.join(dir, '.takt', 'tasks.yaml'), 'utf-8');
  return parseYaml(raw) as { tasks: Array<Record<string, unknown>> };
}

beforeEach(() => {
  vi.clearAllMocks();
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'takt-fork-task-add-'));
  mockDetermineWorkflow.mockResolvedValue('default');
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('addNamedTask', () => {
  it('should save the task under the exact name, with the name as its text and no worktree', async () => {
    mockDetermineWorkflow.mockResolvedValue('consult');

    await addNamedTask(testDir, { name: 'ask-what-first', workflow: 'consult' });

    const task = loadTasks(testDir).tasks[0]!;
    expect(task.name).toBe('ask-what-first');
    expect(task.slug).toBe('ask-what-first');
    expect(task.worktree).toBe(false);
    expect(task.workflow).toBe('consult');
    expect(mockDetermineWorkflow).toHaveBeenCalledWith(testDir, 'consult');
    expect(vi.mocked(summarizeTaskName)).not.toHaveBeenCalled();
    expect(mockPromptInput).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  // The name is a label, not a specification: writing it into order.md made
  // every run open with "Primary spec: order.md" pointing at one word, which
  // outranks the workflow's own instructions.
  it('should leave order.md empty rather than writing the name into it', async () => {
    await addNamedTask(testDir, { name: 'ask-what-first', workflow: 'consult' });

    const task = loadTasks(testDir).tasks[0]!;
    const orderPath = path.join(testDir, String(task.task_dir), 'order.md');
    expect(fs.existsSync(orderPath)).toBe(true);
    expect(fs.readFileSync(orderPath, 'utf-8')).toBe('');
  });

  it('should refuse a name that already exists instead of suffixing it', async () => {
    await addNamedTask(testDir, { name: 'ask-what-first', workflow: 'default' });
    await addNamedTask(testDir, { name: 'ask-what-first', workflow: 'default' });

    expect(loadTasks(testDir).tasks).toHaveLength(1);
    expect(mockError).toHaveBeenCalledWith('Task already exists: ask-what-first');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ['a missing name', { workflow: 'default' }],
    ['a blank name', { name: '   ', workflow: 'default' }],
    ['a missing workflow', { name: 'ask-what-first' }],
  ])('should fail without saving for %s', async (_case, opts) => {
    await addNamedTask(testDir, opts);

    expect(mockError).toHaveBeenCalled();
    expect(mockDetermineWorkflow).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });

  it('should fail without saving when the workflow does not resolve', async () => {
    mockDetermineWorkflow.mockResolvedValue(null);

    await addNamedTask(testDir, { name: 'ask-what-first', workflow: 'nope' });

    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(path.join(testDir, '.takt', 'tasks.yaml'))).toBe(false);
  });
});
