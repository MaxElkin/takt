import { TaskRunner } from '../../../infra/task/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import type { TaskExecutionOptions } from '../execute/types.js';
import { restartTaskFromBeginning, resumeFailedTask } from '../list/taskRetryActions.js';

function findTask(cwd: string, taskName: string) {
  const task = new TaskRunner(cwd).listAllTaskItems()
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
  if (task.kind !== 'failed') {
    throw new Error(
      `Task "${sanitizeTerminalText(taskName)}" cannot be resumed because its status is ${task.kind}.`,
    );
  }
  return resumeFailedTask(task, cwd, agentOverrides);
}
