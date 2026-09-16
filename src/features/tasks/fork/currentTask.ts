/**
 * Fork: the project's current task, and how `--current` resolves to a name.
 *
 * `takt task config --current-task <name>` writes `current_task` to
 * `.takt/config.yaml`; every task subcommand that takes `--name` accepts
 * `--current` instead, so a caller working on one task for a while stops
 * repeating its name. Nothing else reads the key: it is a convenience for the
 * command line, never an input to a run.
 */

import { loadProjectConfig, updateProjectConfig } from '../../../infra/config/index.js';
import { TaskRunner } from '../../../infra/task/index.js';
import { error as logError } from '../../../shared/ui/index.js';
import { getErrorMessage, sanitizeTerminalText } from '../../../shared/utils/index.js';

export function loadCurrentTaskName(cwd: string): string | undefined {
  const value = loadProjectConfig(cwd).currentTask?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function setCurrentTaskName(cwd: string, name: string | undefined): void {
  updateProjectConfig(cwd, 'currentTask', name);
}

/**
 * Clear `current_task` when it names this task, so deleting the current task
 * does not leave the key pointing at something that no longer exists.
 */
export function clearCurrentTaskIfNamed(cwd: string, name: string): void {
  if (loadCurrentTaskName(cwd) !== name) {
    return;
  }
  try {
    setCurrentTaskName(cwd, undefined);
  } catch {
    // The task is already gone; a stale pointer is reported on next use.
  }
}

export interface TaskNameSelection {
  readonly name?: string;
  /** Set when the selection failed; the caller has already been told why. */
  readonly failed?: true;
}

/**
 * Resolve the task a subcommand acts on from `--name` or `--current`.
 *
 * The two are alternatives, not a fallback chain: passing both is a mistake
 * worth reporting rather than silently preferring one, and passing neither
 * names no task at all.
 */
export function resolveTaskName(
  cwd: string,
  opts: { name?: unknown; current?: unknown },
): TaskNameSelection {
  const explicit = typeof opts.name === 'string' ? opts.name.trim() : '';
  const useCurrent = opts.current === true;

  if (useCurrent && explicit.length > 0) {
    logError('Pass either --name or --current, not both.');
    process.exitCode = 1;
    return { failed: true };
  }
  if (!useCurrent) {
    if (explicit.length === 0) {
      logError("Missing required option '--name <name>' (or --current).");
      process.exitCode = 1;
      return { failed: true };
    }
    return { name: explicit };
  }

  const current = loadCurrentTaskName(cwd);
  if (current === undefined) {
    logError('No current task is set. Use `takt task config --current-task <name>`.');
    process.exitCode = 1;
    return { failed: true };
  }
  return { name: current };
}

/** Refuse a `--current-task` value no task answers to, so typos surface now. */
export function assertTaskExists(cwd: string, name: string): boolean {
  try {
    if (new TaskRunner(cwd).listAllTaskItems().some((item) => item.name === name)) {
      return true;
    }
  } catch (err) {
    logError(`Failed to read tasks: ${getErrorMessage(err)}`);
    process.exitCode = 1;
    return false;
  }
  logError(`Task not found: ${sanitizeTerminalText(name)}`);
  process.exitCode = 1;
  return false;
}
