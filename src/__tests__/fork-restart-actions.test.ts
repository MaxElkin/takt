import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockLoadWorkflowByIdentifier,
  mockResolveWorkflowCallTarget,
  mockFindRunForTask,
  mockReadRunMetaBySlug,
  mockStartReExecution,
  mockExecuteAndCompleteTask,
  mockHeader,
  mockAssertReusableWorktreePath,
} = vi.hoisted(() => ({
  mockLoadWorkflowByIdentifier: vi.fn(),
  mockResolveWorkflowCallTarget: vi.fn(),
  mockFindRunForTask: vi.fn((..._args: unknown[]) => null),
  mockReadRunMetaBySlug: vi.fn((..._args: unknown[]) => null),
  mockStartReExecution: vi.fn(),
  mockExecuteAndCompleteTask: vi.fn(),
  mockHeader: vi.fn(),
  mockAssertReusableWorktreePath: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', () => ({
  selectOptionWithDefault: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  header: (...args: unknown[]) => mockHeader(...args),
  blankLine: vi.fn(),
  status: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowConfigValue: vi.fn(),
  loadWorkflowByIdentifier: (...args: unknown[]) => mockLoadWorkflowByIdentifier(...args),
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
  getWorkflowDescription: vi.fn(),
  isWorkflowPath: vi.fn(() => false),
  loadAllStandaloneWorkflowsWithSources: vi.fn(() => new Map()),
}));

vi.mock('../features/interactive/index.js', () => ({
  resolveLanguage: (lang?: string) => lang === 'ja' ? 'ja' : 'en',
  findRunForTask: (...args: unknown[]) => mockFindRunForTask(...args),
  loadRunSessionContext: vi.fn(),
  getRunPaths: vi.fn(),
  formatRunSessionForPrompt: vi.fn(),
  runTaskRetryMode: vi.fn(),
  findPreviousOrderContent: vi.fn(),
}));

vi.mock('../core/workflow/run/run-meta.js', () => ({
  readRunMetaBySlug: (...args: unknown[]) => mockReadRunMetaBySlug(...args),
}));

vi.mock('../infra/task/index.js', () => ({
  TaskRunner: class {
    startReExecution(...args: unknown[]) {
      return mockStartReExecution(...args);
    }
  },
  resolveTaskWorkflowValue: vi.fn((data?: Record<string, unknown>) => (
    typeof data?.workflow === 'string' ? data.workflow : undefined
  )),
  buildAutoRequeueNote: vi.fn((failure: { step?: string; error: string }) => (
    `auto-requeue ${JSON.stringify({ failedStep: failure.step, error: failure.error })}`
  )),
}));

vi.mock('../features/tasks/execute/taskExecution.js', () => ({
  executeAndCompleteTask: (...args: unknown[]) => mockExecuteAndCompleteTask(...args),
}));

vi.mock('../features/tasks/execute/reusedWorktree.js', () => ({
  assertReusableWorktreePath: (...args: unknown[]) => mockAssertReusableWorktreePath(...args),
}));

import {
  restartTaskFromBeginning,
  rewindTaskFromStep,
  startPendingTask,
} from '../features/tasks/restart/restartActions.js';
import type { TaskListItem } from '../infra/task/types.js';
import type { WorkflowConfig } from '../core/models/index.js';
import { makeStep } from './engine-test-helpers.js';

const defaultWorkflowConfig: WorkflowConfig = {
  name: 'default',
  description: 'Default workflow',
  initialStep: 'plan',
  maxSteps: 30,
  steps: [
    makeStep('plan'),
    makeStep('implement'),
    makeStep('review'),
  ],
};

const defaultPlanRestartPoint = {
  stack: [{
    workflow: 'default',
    workflow_ref: 'default',
    step: 'plan',
    kind: 'agent' as const,
  }],
};

const autoRequeueNote = 'auto-requeue {"failedStep":"review","error":"Boom"}';

function makeFailedTask(overrides?: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'failed',
    name: 'my-task',
    createdAt: '2025-01-15T12:02:00.000Z',
    filePath: '/project/.takt/tasks.yaml',
    content: 'Do something',
    branch: 'takt/my-task',
    worktreePath: '/project/.takt/worktrees/my-task',
    data: { task: 'Do something', workflow: 'default' },
    failure: { step: 'review', error: 'Boom' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadWorkflowByIdentifier.mockReturnValue(defaultWorkflowConfig);
  mockStartReExecution.mockReturnValue({
    name: 'my-task',
    content: 'Do something',
    data: { task: 'Do something', workflow: 'default' },
  });
  mockExecuteAndCompleteTask.mockResolvedValue(true);
});

describe('restartTaskFromBeginning', () => {
  it('should restart a completed task from the initial step without failure feedback', async () => {
    const task = makeFailedTask({ kind: 'completed', failure: undefined });

    const result = await restartTaskFromBeginning(task, '/project');

    expect(result).toBe(true);
    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed', 'completed'], 'retry', {
      retryNote: undefined,
      taskDir: undefined,
      sourceRunSlug: undefined,
      restartPoint: defaultPlanRestartPoint,
    });
    expect(mockHeader).not.toHaveBeenCalled();
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should run a worktree-less task in the project directory', async () => {
    const task = makeFailedTask({ worktreePath: undefined });

    await restartTaskFromBeginning(task, '/project');

    expect(mockAssertReusableWorktreePath).not.toHaveBeenCalled();
    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith('default', '/project', { lookupCwd: '/project' });
  });

  it('should check the worktree of a task that has one', async () => {
    await restartTaskFromBeginning(makeFailedTask(), '/project');

    expect(mockAssertReusableWorktreePath).toHaveBeenCalledWith('/project', '/project/.takt/worktrees/my-task');
  });

  it('should include failure feedback when restarting a failed task', async () => {
    const result = await restartTaskFromBeginning(makeFailedTask(), '/project');

    expect(result).toBe(true);
    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['failed', 'completed'], 'retry', {
      retryNote: autoRequeueNote,
      taskDir: undefined,
      sourceRunSlug: undefined,
      restartPoint: defaultPlanRestartPoint,
    });
    expect(mockHeader).toHaveBeenCalled();
  });
});

describe('startPendingTask', () => {
  it('should claim the pending task and execute it without retry metadata', async () => {
    const task = makeFailedTask({ kind: 'pending', failure: undefined });

    const result = await startPendingTask(task, '/project');

    expect(result).toBe(true);
    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['pending'], 'retry', {});
    expect(mockExecuteAndCompleteTask).toHaveBeenCalled();
  });

  it('should refuse a task that is not pending', async () => {
    await expect(startPendingTask(makeFailedTask(), '/project')).rejects.toThrow(
      'Task start requires a pending task. received: failed',
    );
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });
});

describe('rewindTaskFromStep', () => {
  const nestedChild: WorkflowConfig = {
    name: 'consult-review',
    description: 'Review subworkflow',
    initialStep: 'review',
    maxSteps: 4,
    subworkflow: { callable: true },
    steps: [makeStep('review'), makeStep('plan')],
  };
  const nestedRoot: WorkflowConfig = {
    name: 'default',
    description: 'Root with a callable child',
    initialStep: 'plan',
    maxSteps: 12,
    steps: [
      makeStep('plan'),
      makeStep('review', { kind: 'workflow_call', call: 'review/consult-review' }),
    ],
  };

  function useNestedWorkflow(): void {
    mockLoadWorkflowByIdentifier.mockReturnValue(nestedRoot);
    mockResolveWorkflowCallTarget.mockReturnValue(nestedChild);
  }

  const rootPlanRestartPoint = {
    stack: [{ workflow: 'default', workflow_ref: 'default', step: 'plan', kind: 'agent' }],
  };
  const nestedPlanRestartPoint = {
    stack: [
      { workflow: 'default', workflow_ref: 'default', step: 'review', kind: 'workflow_call', call_instance: 1 },
      { workflow: 'consult-review', workflow_ref: 'consult-review', step: 'plan', kind: 'agent' },
    ],
  };

  it('should rewind a failed task to a root step, keeping its own workflow', async () => {
    const result = await rewindTaskFromStep(makeFailedTask(), '/project', { step: 'plan' });

    expect(result).toBe(true);
    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith(
      'default',
      '/project',
      { lookupCwd: '/project/.takt/worktrees/my-task' },
    );
    expect(mockStartReExecution).toHaveBeenCalledWith('my-task', ['pending', 'failed', 'completed'], 'retry', {
      retryNote: autoRequeueNote,
      taskDir: undefined,
      sourceRunSlug: undefined,
      restartPoint: rootPlanRestartPoint,
    });
  });

  // The start pointer is the record's workflow: rewind moves where execution
  // resumes, never what the task is.
  it('should not write a workflow into the task record, even with --workflow', async () => {
    useNestedWorkflow();

    await rewindTaskFromStep(makeFailedTask(), '/project', {
      workflow: 'consult-review',
      step: 'plan',
    });

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'my-task',
      ['pending', 'failed', 'completed'],
      'retry',
      expect.not.objectContaining({ workflow: expect.anything() }),
    );
    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledTimes(1);
    expect(mockLoadWorkflowByIdentifier).toHaveBeenCalledWith('default', '/project', expect.anything());
  });

  it('should narrow an ambiguous step to the workflow named by --workflow', async () => {
    useNestedWorkflow();

    await rewindTaskFromStep(makeFailedTask(), '/project', {
      workflow: 'consult-review',
      step: 'plan',
    });

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'my-task',
      expect.anything(),
      'retry',
      expect.objectContaining({ restartPoint: nestedPlanRestartPoint }),
    );
  });

  // The record addresses its workflow the way `takt task add` was given it.
  it('should accept the folder-qualified identifier the task stores', async () => {
    useNestedWorkflow();
    const task = makeFailedTask({ data: { task: 'Do something', workflow: 'category/default' } });

    await rewindTaskFromStep(task, '/project', { workflow: 'category/default', step: 'plan' });

    expect(mockStartReExecution).toHaveBeenCalledWith(
      'my-task',
      expect.anything(),
      'retry',
      expect.objectContaining({ restartPoint: rootPlanRestartPoint }),
    );
  });

  it('should reject a workflow that is not reachable from the task workflow', async () => {
    useNestedWorkflow();

    await expect(rewindTaskFromStep(makeFailedTask(), '/project', {
      workflow: 'elsewhere',
      step: 'plan',
    })).rejects.toThrow(/"elsewhere" is not reachable from "default"; reachable workflows: "default", "consult-review"/u);
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', undefined, undefined],
    ['completed', undefined, undefined],
    ['failed', { step: 'review', error: 'Boom' }, autoRequeueNote],
  ] as const)('should rewind a %s task', async (kind, failure, retryNote) => {
    const task = makeFailedTask({ kind, ...(failure === undefined ? { failure: undefined } : { failure }) });

    await expect(rewindTaskFromStep(task, '/project', { step: 'plan' })).resolves.toBe(true);
    expect(mockStartReExecution).toHaveBeenCalledWith(
      'my-task',
      ['pending', 'failed', 'completed'],
      'retry',
      expect.objectContaining({ retryNote, restartPoint: rootPlanRestartPoint }),
    );
  });

  it('should refuse a running task', async () => {
    const task = makeFailedTask({ kind: 'running', failure: undefined });

    await expect(rewindTaskFromStep(task, '/project', { step: 'plan' })).rejects.toThrow(
      'Task rewind requires pending, failed or completed task. received: running',
    );
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });

  it('should reject a step that is not an authored restart target', async () => {
    await expect(rewindTaskFromStep(makeFailedTask(), '/project', { step: 'missing' })).rejects.toThrow(
      'has no authored restart step "missing"',
    );
    expect(mockStartReExecution).not.toHaveBeenCalled();
  });
});
