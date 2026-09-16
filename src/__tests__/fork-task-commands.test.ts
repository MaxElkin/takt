import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockAddNamedTask,
  mockPrintTaskTable,
  mockDeleteNamedTask,
  mockPruneOrphans,
  mockConfigureTasks,
  mockResumeTask,
  mockRestartTask,
  mockRewindTask,
} = vi.hoisted(() => ({
  mockResumeTask: vi.fn(),
  mockRestartTask: vi.fn(),
  mockRewindTask: vi.fn(),
  mockAddNamedTask: vi.fn(),
  mockPrintTaskTable: vi.fn(),
  mockDeleteNamedTask: vi.fn(),
  mockPruneOrphans: vi.fn(),
  mockConfigureTasks: vi.fn(),
}));

vi.mock('../app/cli/program.js', async () => {
  const { Command } = await import('commander');
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .option('-w, --workflow <name>', 'Workflow')
    .option('--provider <name>', 'Provider')
    .option('--model <name>', 'Model');
  return { program };
});

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: () => ({ cwd: '/test/cwd' }),
}));

vi.mock('../features/tasks/fork/addNamedTask.js', () => ({ addNamedTask: mockAddNamedTask }));
vi.mock('../features/tasks/fork/printTaskTable.js', () => ({ printTaskTable: mockPrintTaskTable }));
vi.mock('../features/tasks/fork/deleteNamedTask.js', () => ({ deleteNamedTask: mockDeleteNamedTask }));
vi.mock('../features/tasks/fork/pruneOrphans.js', () => ({ pruneOrphans: mockPruneOrphans }));
vi.mock('../features/tasks/fork/configureTasks.js', () => ({ configureTasks: mockConfigureTasks }));
vi.mock('../features/tasks/restart/index.js', () => ({
  resumeTask: mockResumeTask,
  restartTask: mockRestartTask,
  rewindTask: mockRewindTask,
}));

import { program } from '../app/cli/program.js';
import '../app/cli/fork/taskCommands.js';

function run(...args: string[]): Promise<unknown> {
  return program.parseAsync(args, { from: 'user' });
}

describe('fork task command wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('should pass --name and --workflow to addNamedTask', async () => {
    await run('task', 'add', '--name', 'ask-what-first', '--workflow', 'consult');

    expect(mockAddNamedTask).toHaveBeenCalledWith('/test/cwd', { name: 'ask-what-first', workflow: 'consult' });
  });

  it('should print the task table for task list', async () => {
    await run('task', 'list');

    expect(mockPrintTaskTable).toHaveBeenCalledWith('/test/cwd');
  });

  it('should pass the workflow and step to task rewind', async () => {
    await run('task', 'rewind', '--name', 'ask-what-first', '--workflow', 'consult', '--step', 'ask');

    expect(mockRewindTask).toHaveBeenCalledWith('/test/cwd', 'ask-what-first', {
      workflow: 'consult',
      step: 'ask',
      agentOverrides: undefined,
    });
  });

  // Commander stores a subcommand option into the parent when their long names
  // collide, so rewind's `--workflow` and the global `-w` are one slot. Rewind
  // only reads it to narrow `--step`, so an inherited one is refused downstream
  // rather than acted on - but the sharing itself has to stay visible here.
  it('should read the global workflow option as the task rewind filter', async () => {
    await run('--workflow', 'global-one', 'task', 'rewind', '--name', 'ask-what-first', '--step', 'ask');

    expect(mockRewindTask).toHaveBeenCalledWith('/test/cwd', 'ask-what-first', {
      workflow: 'global-one',
      step: 'ask',
      agentOverrides: undefined,
    });
  });

  // Runs before the --name cases: commander keeps option values between parses.
  // `--name` is no longer commander-required, because `--current` is the other
  // way to name a task, so the refusal is reported the way `add` and `delete`
  // report theirs: a message and a non-zero exit code, not a thrown error.
  it.each(['resume', 'restart'])('should reject task %s without --name or --current', async (name) => {
    await run('task', name);

    expect(process.exitCode).toBe(1);
    expect(mockResumeTask).not.toHaveBeenCalled();
    expect(mockRestartTask).not.toHaveBeenCalled();
  });

  it.each([
    ['resume', mockResumeTask],
    ['restart', mockRestartTask],
  ] as const)('should pass --name and CLI agent overrides to task %s', async (name, handler) => {
    await run('--provider', 'mock', '--model', 'gpt-test', 'task', name, '--name', 'task with spaces');

    expect(handler).toHaveBeenCalledWith('/test/cwd', 'task with spaces', {
      provider: 'mock',
      providerSource: 'cli',
      model: 'gpt-test',
      modelSource: 'cli',
    });
  });

  it('should pass --name to deleteNamedTask', async () => {
    await run('task', 'delete', '--name', 'ask-what-first');

    expect(mockDeleteNamedTask).toHaveBeenCalledWith('/test/cwd', 'ask-what-first');
  });

  it('should run pruneOrphans for task prune, which takes no options', async () => {
    await run('task', 'prune');

    expect(mockPruneOrphans).toHaveBeenCalledWith('/test/cwd');
  });

  it('should pass --tasks-artifacts-dir to configureTasks', async () => {
    await run('task', 'config', '--tasks-artifacts-dir', 'syncthing/docs/project/tasks');

    expect(mockConfigureTasks).toHaveBeenCalledWith('/test/cwd', {
      tasksArtifactsDir: 'syncthing/docs/project/tasks',
    });
  });
});
