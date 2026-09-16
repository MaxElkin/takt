import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TaskRunner } from '../../../infra/task/index.js';
import { findTaskRunDirectories, formatBytes } from './taskRunDirectories.js';
import { confirm } from '../../../shared/prompt/index.js';
import { info, success, error as logError } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { deleteBranch } from '../list/taskActions.js';
import { clearCurrentTaskIfNamed } from './currentTask.js';

/**
 * Fork: task delete command handler: delete one task by exact name after confirmation.
 *
 * Past the prompt it mirrors upstream deleteTaskByKind in list/taskDeleteActions.ts:
 * the task's branch is deleted first, and the record is kept if that fails.
 * Failures set a non-zero exit code; a declined confirmation deletes nothing.
 */
export async function deleteNamedTask(cwd: string, name: string | undefined): Promise<void> {
  const taskName = name?.trim();
  if (!taskName) {
    logError("Missing required option '--name <name>'.");
    process.exitCode = 1;
    return;
  }
  const runner = new TaskRunner(cwd);
  let allTasks = runner.listAllTaskItems();
  let task = allTasks.find((item) => item.name === taskName);
  if (task?.kind === 'running') {
    // A task killed without a graceful shutdown stays `running` with a dead
    // `owner_pid`, and upstream only heals that inside `takt run` /
    // `takt watch`. Without this, delete refuses a task nothing is running -
    // the same gap `resume` and `restart` close. Healing rewrites tasks.yaml,
    // so it runs only for the task that needs it. One a live process owns
    // stays `running` and is refused below.
    runner.failInterruptedRunningTasks();
    allTasks = runner.listAllTaskItems();
    task = allTasks.find((item) => item.name === taskName);
  }
  if (!task) {
    logError(`Task not found: ${taskName}`);
    process.exitCode = 1;
    return;
  }
  const kind = task.kind;
  if (kind === 'running') {
    logError(`Cannot delete running task "${taskName}"`);
    process.exitCode = 1;
    return;
  }
  const projectDir = dirname(dirname(task.filePath));
  const runs = findTaskRunDirectories(
    projectDir,
    task,
    allTasks.filter((item) => item.name !== task.name),
  );
  if (runs.incomplete) {
    info('Some runs could not be identified; they are left in place.');
  }
  const extras = [
    ...(runs.slugs.length > 0
      ? [`its ${runs.slugs.length} run${runs.slugs.length === 1 ? '' : 's'} (${formatBytes(runs.bytes)})`]
      : []),
    ...(task.taskDir ? ['its task directory'] : []),
  ];
  const question = extras.length === 0
    ? `Delete ${kind} task "${task.name}"?`
    : `Delete ${kind} task "${task.name}" and ${extras.join(' and ')}?`;
  if (!(await confirm(question, false))) {
    info('Cancelled.');
    return;
  }

  try {
    if (task.branch && !deleteBranch(projectDir, task)) {
      process.exitCode = 1;
      return;
    }
    new TaskRunner(projectDir).deleteTask(task.name, kind);
  } catch (err) {
    logError(`Failed to delete ${kind} task "${task.name}": ${getErrorMessage(err)}`);
    process.exitCode = 1;
    return;
  }
  // The record is gone; its runs and its task directory are now unreachable,
  // so they go too. Failing here is reported but does not undo the delete.
  for (const slug of runs.slugs) {
    try {
      rmSync(join(projectDir, '.takt', 'runs', slug), { recursive: true, force: true });
    } catch (err) {
      logError(`Failed to delete run "${slug}": ${getErrorMessage(err)}`);
      process.exitCode = 1;
    }
  }
  if (task.taskDir) {
    try {
      rmSync(join(projectDir, task.taskDir), { recursive: true, force: true });
    } catch (err) {
      logError(`Failed to delete task directory "${task.taskDir}": ${getErrorMessage(err)}`);
      process.exitCode = 1;
    }
  }
  // `current_task` may name the task just deleted; leaving it would make every
  // later `--current` fail on a task that no longer exists.
  clearCurrentTaskIfNamed(projectDir, task.name);
  success(`Deleted ${kind} task: ${task.name}`);
}
