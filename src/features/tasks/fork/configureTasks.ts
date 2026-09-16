import { loadProjectConfig, updateProjectConfig } from '../../../infra/config/index.js';
import { validateTasksArtifactsDir } from '../../../core/workflow/instruction/fork/taskArtifactsDir.js';
import { info, success, error as logError } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';
import { assertTaskExists, setCurrentTaskName } from './currentTask.js';

export interface ConfigureTasksOptions {
  readonly tasksArtifactsDir?: string | undefined;
  readonly currentTask?: string | undefined;
}

/**
 * Fork: task config command handler: read or set the task-scoped keys of
 * `.takt/config.yaml`.
 *
 * Without options it prints the current values and changes nothing, so the
 * command is safe to run to find out what is configured. `--tasks-artifacts-dir`
 * sets the parent directory `{task_artifacts_dir}` resolves under;
 * `--current-task` sets the task `--current` resolves to. `""` clears either.
 */
export function configureTasks(cwd: string, options: ConfigureTasksOptions): void {
  if (options.tasksArtifactsDir === undefined && options.currentTask === undefined) {
    const config = loadProjectConfig(cwd);
    info(`tasks_artifacts_dir: ${config.tasksArtifactsDir ?? '(not set)'}`);
    info(`current_task: ${config.currentTask ?? '(not set)'}`);
    return;
  }
  if (options.tasksArtifactsDir !== undefined) {
    setTasksArtifactsDir(cwd, options.tasksArtifactsDir);
  }
  if (options.currentTask !== undefined && process.exitCode !== 1) {
    setCurrentTask(cwd, options.currentTask);
  }
}

function setTasksArtifactsDir(cwd: string, requested: string): void {
  const value = requested.trim().replace(/\/+$/, '');
  if (value.length > 0) {
    const rejection = validateTasksArtifactsDir(value);
    if (rejection !== undefined) {
      logError(`Invalid --tasks-artifacts-dir "${requested}": it ${rejection}.`);
      process.exitCode = 1;
      return;
    }
  }

  try {
    updateProjectConfig(cwd, 'tasksArtifactsDir', value.length === 0 ? undefined : value);
  } catch (err) {
    logError(`Failed to update .takt/config.yaml: ${getErrorMessage(err)}`);
    process.exitCode = 1;
    return;
  }
  success(value.length === 0
    ? 'Cleared tasks_artifacts_dir.'
    : `Set tasks_artifacts_dir: ${value}`);
}

/**
 * A name no task answers to is refused rather than stored: `--current` would
 * fail on every later command, and the mistake is easier to see here.
 */
function setCurrentTask(cwd: string, requested: string): void {
  const value = requested.trim();
  if (value.length > 0 && !assertTaskExists(cwd, value)) {
    return;
  }

  try {
    setCurrentTaskName(cwd, value.length === 0 ? undefined : value);
  } catch (err) {
    logError(`Failed to update .takt/config.yaml: ${getErrorMessage(err)}`);
    process.exitCode = 1;
    return;
  }
  success(value.length === 0 ? 'Cleared current_task.' : `Set current_task: ${value}`);
}
