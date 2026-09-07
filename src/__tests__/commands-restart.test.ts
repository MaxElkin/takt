import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProgramOpts: Record<string, unknown> = {};
const mockRestartTask = vi.fn();

const { rootCommand, commandActions, commandMocks } = vi.hoisted(() => {
  const commandActions = new Map<string, (...args: unknown[]) => void>();
  const commandMocks = new Map<string, Record<string, unknown>>();

  function createCommandMock(actionKey: string): {
    description: ReturnType<typeof vi.fn>;
    argument: ReturnType<typeof vi.fn>;
    requiredOption: ReturnType<typeof vi.fn>;
    option: ReturnType<typeof vi.fn>;
    opts: ReturnType<typeof vi.fn>;
    optsWithGlobals: ReturnType<typeof vi.fn>;
    action: (action: (...args: unknown[]) => void) => unknown;
    command: ReturnType<typeof vi.fn>;
  } {
    const command: Record<string, unknown> = {
      description: vi.fn().mockReturnThis(),
      argument: vi.fn().mockReturnThis(),
      requiredOption: vi.fn().mockReturnThis(),
      option: vi.fn().mockReturnThis(),
      opts: vi.fn(() => mockProgramOpts),
      optsWithGlobals: vi.fn(() => mockProgramOpts),
    };
    commandMocks.set(actionKey, command);

    command.command = vi.fn((subName: string) => createCommandMock(`${actionKey}.${subName}`));
    command.action = vi.fn((action: (...args: unknown[]) => void) => {
      commandActions.set(actionKey, action);
      return command;
    });

    return command as ReturnType<typeof createCommandMock>;
  }

  return {
    rootCommand: createCommandMock('root'),
    commandActions,
    commandMocks,
  };
});

vi.mock('../app/cli/program.js', () => ({
  program: rootCommand,
}));

vi.mock('../app/cli/initialization.js', () => ({
  getCliExecutionContext: vi.fn(() => ({ cwd: '/test/cwd', pipelineMode: false })),
}));

vi.mock('../features/tasks/restart/index.js', () => ({
  restartTask: (...args: unknown[]) => mockRestartTask(...args),
}));

import '../app/cli/commands.js';

describe('CLI restart command', () => {
  beforeEach(() => {
    mockRestartTask.mockClear();
    for (const key of Object.keys(mockProgramOpts)) {
      delete mockProgramOpts[key];
    }
  });

  it('registers a required task name argument', () => {
    const calledCommandNames = rootCommand.command.mock.calls
      .map((call: unknown[]) => call[0] as string);

    expect(calledCommandNames).toContain('restart');
    expect(commandMocks.get('root.restart')?.argument).toHaveBeenCalledWith(
      '<task-name>',
      'Exact task name',
    );
  });

  it('restarts the named failed or completed task with CLI agent overrides', async () => {
    mockProgramOpts.provider = 'mock';
    mockProgramOpts.model = 'gpt-test';
    const restartAction = commandActions.get('root.restart');

    expect(restartAction).toBeTypeOf('function');

    await restartAction?.('task with spaces');

    expect(mockRestartTask).toHaveBeenCalledWith('/test/cwd', 'task with spaces', {
      provider: 'mock',
      providerSource: 'cli',
      model: 'gpt-test',
      modelSource: 'cli',
    });
  });
});
