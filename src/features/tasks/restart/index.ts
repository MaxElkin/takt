import { TaskRunner } from '../../../infra/task/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import {
  restartTaskFromBeginning,
  resumeFailedTask,
  rewindTaskFromStep,
  startPendingTask,
} from './restartActions.js';

/**
 * A task killed without a graceful shutdown stays `running` with a dead
 * `owner_pid`; upstream only heals that inside `takt run` / `takt watch`, so
 * these commands would refuse a task nothing is running. Heal first, then
 * read the list.
 */
function findTask(cwd: string, taskName: string) {
  const runner = new TaskRunner(cwd);
  runner.failInterruptedRunningTasks();
  const task = runner.listAllTaskItems()
    .find((candidate) => candidate.name === taskName);

  if (task === undefined) {
    throw new Error(`Task not found: ${sanitizeTerminalText(taskName)}`);
  }
  return task;
}

export async function restartTask(
  cwd: string,
  taskName: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  const task = findTask(cwd, taskName);
  if (task.kind === 'pending') {
    return startPendingTask(task, cwd, agentOverrides);
  }
  if (task.kind !== 'failed' && task.kind !== 'completed') {
    throw new Error(
      `Task "${sanitizeTerminalText(taskName)}" cannot be restarted because its status is ${task.kind}.`,
    );
  }
  return restartTaskFromBeginning(task, cwd, agentOverrides);
}

export async function resumeTask(
  cwd: string,
  taskName: string,
  agentOverrides?: TaskExecutionOptions,
): Promise<boolean> {
  const task = findTask(cwd, taskName);
  if (task.kind === 'pending') {
    return startPendingTask(task, cwd, agentOverrides);
  }
  if (task.kind !== 'failed') {
    throw new Error(
      `Task "${sanitizeTerminalText(taskName)}" cannot be resumed because its status is ${task.kind}.`,
    );
  }
  return resumeFailedTask(task, cwd, agentOverrides);
}

export async function rewindTask(
  cwd: string,
  taskName: string,
  options: {
    workflow?: string;
    step: string;
    agentOverrides?: TaskExecutionOptions;
  },
): Promise<boolean> {
  const task = findTask(cwd, taskName);
  return rewindTaskFromStep(task, cwd, options);
}
