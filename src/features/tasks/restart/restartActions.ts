/**
 * Direct restart and resume of a queued task, without the retry conversation.
 *
 * Built on the private helpers of list/taskRetryActions.ts, which exports them
 * through a fork hook at the end of that file.
 */

import type { TaskListItem } from '../../../infra/task/index.js';
import { TaskRunner, resolveTaskWorkflowValue } from '../../../infra/task/index.js';
import { loadWorkflowByIdentifier } from '../../../infra/config/index.js';
import { createLogger } from '../../../shared/utils/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { executeAndCompleteTask } from '../execute/taskExecution.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import { assertReusableWorktreePath } from '../execute/reusedWorktree.js';
import { appendRetryNote, buildAutoRequeueNote } from '../list/requeueHelpers.js';
import { prepareTaskForExecution } from '../list/prepareTaskForExecution.js';
import {
  displayFailureInfo,
  readRetryRunMeta,
  requireFailedTaskFailure,
  resolveFailureStepForRequeueNote,
  resolveRetryDefaultStep,
  resolveRetryResumePoint,
  resolveRetryRunSlug,
} from '../list/taskRetryActions.js';
import { buildInitialWorkflowRestartPoint } from './initialRestartPoint.js';
import { resolveTaskRewindRestartPoint } from './stepSelector.js';

const log = createLogger('list-tasks');

/**
 * Where the task's run happened, and where its `.takt/runs` state lives.
 *
 * Upstream's retry path requires `worktreePath` and fails without one, because
 * the interactive flow it serves is worktree-based. A `worktree: false` task -
 * what `takt task add` creates - runs in the project directory itself, so that
 * is its execution directory.
 */
function resolveExecutionDir(projectDir: string, task: TaskListItem): string {
  if (!task.worktreePath) {
    return projectDir;
  }
  assertReusableWorktreePath(projectDir, task.worktreePath);
  return task.worktreePath;
}

/**
 * Restart a failed or completed task from the workflow's initial step.
 */
export async function restartTaskFromBeginning(
  task: TaskListItem,
  projectDir: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  if (task.kind !== 'failed' && task.kind !== 'completed') {
    throw new Error(`Task restart requires failed or completed task. received: ${task.kind}`);
  }
  const failure = task.kind === 'failed' ? requireFailedTaskFailure(task) : undefined;
  const worktreePath = resolveExecutionDir(projectDir, task);
  const workflow = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;
  if (!workflow) {
    throw new Error(`Task "${sanitizeTerminalText(task.name)}" is missing its workflow.`);
  }
  const workflowConfig = loadWorkflowByIdentifier(workflow, projectDir, { lookupCwd: worktreePath });
  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(workflow)}" is unavailable for restart.`);
  }
  const restartPoint = buildInitialWorkflowRestartPoint(workflowConfig, {
    projectCwd: projectDir,
    lookupCwd: worktreePath,
  });
  const retryNote = failure === undefined
    ? undefined
    : appendRetryNote(
        task.data?.retry_note,
        buildAutoRequeueNote({
          ...failure,
          step: failure.step,
        }),
      );
  if (failure !== undefined) {
    displayFailureInfo(task, failure);
  }
  const runner = new TaskRunner(projectDir);
  const taskInfo = runner.startReExecution(
    task.name,
    ['failed', 'completed'],
    'retry',
    {
      retryNote,
      taskDir: undefined,
      sourceRunSlug: resolveRetryRunSlug(task, worktreePath) ?? undefined,
      restartPoint,
    },
  );
  const taskForExecution = prepareTaskForExecution(taskInfo, workflow);

  log.info('Restarting task from beginning', {
    name: task.name,
    worktreePath,
    restartPoint,
  });

  return executeAndCompleteTask(taskForExecution, runner, projectDir, agentOverrides);
}

/** Re-execute a task from a selected authored workflow step. */
export async function rewindTaskFromStep(
  task: TaskListItem,
  projectDir: string,
  options: {
    workflow?: string;
    step: string;
    agentOverrides?: TaskExecutionOptions;
  },
): Promise<boolean> {
  if (task.kind !== 'pending' && task.kind !== 'failed' && task.kind !== 'completed') {
    throw new Error(`Task rewind requires pending, failed or completed task. received: ${task.kind}`);
  }
  const failure = task.kind === 'failed' ? requireFailedTaskFailure(task) : undefined;
  const worktreePath = resolveExecutionDir(projectDir, task);
  // Rewind moves the task's current pointer, never its start pointer: the
  // workflow the record was queued with is what runs, and `--workflow` only
  // narrows which reachable workflow inside that tree `--step` belongs to.
  const workflow = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;
  if (!workflow) {
    throw new Error(`Task "${sanitizeTerminalText(task.name)}" is missing its workflow.`);
  }
  const workflowConfig = loadWorkflowByIdentifier(workflow, projectDir, { lookupCwd: worktreePath });
  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(workflow)}" is unavailable for rewind.`);
  }
  const restartPoint = resolveTaskRewindRestartPoint(
    workflowConfig,
    options.step,
    { projectCwd: projectDir, lookupCwd: worktreePath },
    {
      rootIdentifier: workflow,
      ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    },
  );
  const retryNote = failure === undefined
    ? undefined
    : appendRetryNote(
        task.data?.retry_note,
        buildAutoRequeueNote({
          ...failure,
          step: failure.step,
        }),
      );
  if (failure !== undefined) {
    displayFailureInfo(task, failure);
  }
  const runner = new TaskRunner(projectDir);
  const taskInfo = runner.startReExecution(
    task.name,
    ['pending', 'failed', 'completed'],
    'retry',
    {
      retryNote,
      taskDir: undefined,
      sourceRunSlug: resolveRetryRunSlug(task, worktreePath) ?? undefined,
      restartPoint,
    },
  );
  const taskForExecution = prepareTaskForExecution(taskInfo, workflow);

  log.info('Rewinding task to selected step', {
    name: task.name,
    worktreePath,
    workflow,
    step: options.step,
    restartPoint,
  });

  return executeAndCompleteTask(taskForExecution, runner, projectDir, options.agentOverrides);
}

/**
 * Start a pending task immediately, which is the work `takt run` would do for
 * it, narrowed to one task by name. The record carries no checkpoint yet, so
 * the workflow simply starts at its initial step.
 */
export async function startPendingTask(
  task: TaskListItem,
  projectDir: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  if (task.kind !== 'pending') {
    throw new Error(`Task start requires a pending task. received: ${task.kind}`);
  }
  const workflow = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;
  if (!workflow) {
    throw new Error(`Task "${sanitizeTerminalText(task.name)}" is missing its workflow.`);
  }
  const runner = new TaskRunner(projectDir);
  const taskInfo = runner.startReExecution(task.name, ['pending'], 'retry', {});
  const taskForExecution = prepareTaskForExecution(taskInfo, workflow);

  log.info('Starting pending task', { name: task.name });

  return executeAndCompleteTask(taskForExecution, runner, projectDir, agentOverrides);
}

/** Resume a failed task immediately from its saved checkpoint or failed step. */
export async function resumeFailedTask(
  task: TaskListItem,
  projectDir: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  const failure = requireFailedTaskFailure(task);
  const worktreePath = resolveExecutionDir(projectDir, task);
  const workflow = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;
  if (!workflow) {
    throw new Error(`Failed task "${sanitizeTerminalText(task.name)}" is missing its workflow.`);
  }
  const workflowConfig = loadWorkflowByIdentifier(workflow, projectDir, { lookupCwd: worktreePath });
  if (!workflowConfig) {
    throw new Error(`Workflow "${sanitizeTerminalText(workflow)}" is unavailable for resume.`);
  }
  const matchedSlug = resolveRetryRunSlug(task, worktreePath);
  const runMeta = readRetryRunMeta(worktreePath, matchedSlug);
  const resumePoint = resolveRetryResumePoint(task, runMeta);
  const currentStep = resolveRetryDefaultStep(workflowConfig, failure, resumePoint);
  const startStep = resumePoint === undefined
    ? currentStep ?? undefined
    : currentStep === workflowConfig.initialStep ? undefined : currentStep ?? undefined;
  const retryNote = appendRetryNote(
    task.data?.retry_note,
    buildAutoRequeueNote({
      ...failure,
      step: resolveFailureStepForRequeueNote(failure, runMeta, resumePoint),
    }),
  );

  displayFailureInfo(task, failure);
  const runner = new TaskRunner(projectDir);
  const taskInfo = runner.startReExecution(
    task.name,
    ['failed'],
    'retry',
    {
      startStep,
      retryNote,
      resumePoint,
      taskDir: undefined,
      sourceRunSlug: matchedSlug ?? undefined,
    },
  );
  const taskForExecution = prepareTaskForExecution(taskInfo, workflow);

  log.info('Resuming failed task', {
    name: task.name,
    worktreePath,
    startStep,
    resumePoint,
  });

  return executeAndCompleteTask(taskForExecution, runner, projectDir, agentOverrides);
}
