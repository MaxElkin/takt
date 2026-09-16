/**
 * Fork: finding a task and the step it currently stands on.
 *
 * Shared by `takt task tree` and `takt task instruction` so both name the same
 * step as current - and name the step a resume would continue from, since the
 * pointer is read the way `takt task resume` reads it: run meta first, then the
 * record.
 */

import type { WorkflowConfig } from '../../../core/models/index.js';
import type {
  WorkflowRestartPointEntry,
  WorkflowResumePointEntry,
} from '../../../core/models/index.js';
import { loadWorkflowByIdentifier } from '../../../infra/config/index.js';
import {
  TaskRunner,
  resolveTaskWorkflowValue,
  type TaskListItem,
} from '../../../infra/task/index.js';
import { error } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/index.js';
import { readRetryRunMeta, resolveRetryRunSlug } from '../list/taskRetryActions.js';

/** One frame of a task's current pointer; both point shapes supply these. */
export type TaskPointerEntry = Pick<
  WorkflowResumePointEntry | WorkflowRestartPointEntry,
  'workflow' | 'step'
>;

export interface LocatedTask {
  readonly task: TaskListItem;
  /** The task's workflow as written on the record. */
  readonly workflowIdentifier: string;
  readonly workflow: WorkflowConfig;
  /** Where the task's run state lives. */
  readonly lookupCwd: string;
  /** The task's most recent run, absent when it has never run. */
  readonly runSlug?: string;
  /** The task's current position, absent when it has never run. */
  readonly pointer?: readonly TaskPointerEntry[];
}

/**
 * Where the task's run state lives. A `worktree: false` task - what
 * `takt task add` creates - runs in the project directory itself.
 */
function resolveLookupCwd(projectDir: string, task: TaskListItem): string {
  return task.worktreePath ?? projectDir;
}

/**
 * The task's current position. A staged rewind owns `restart_point`; otherwise
 * the resume point is authoritative, and a task that has never run has neither.
 */
function resolveTaskPointer(
  task: TaskListItem,
  lookupCwd: string,
  runSlug: string | null,
): readonly TaskPointerEntry[] | undefined {
  const restartPoint = task.data?.restart_point;
  if (restartPoint !== undefined) {
    return restartPoint.stack;
  }
  const runMeta = readRetryRunMeta(lookupCwd, runSlug);
  return (runMeta?.resumePoint ?? task.data?.resume_point)?.stack;
}

/**
 * Resolve a task by exact name together with its workflow and pointer.
 * Every failure is reported and sets a non-zero exit code, so a caller that
 * gets undefined has nothing left to say.
 */
export function locateTask(projectDir: string, name: string): LocatedTask | undefined {
  const task = new TaskRunner(projectDir).listAllTaskItems().find((item) => item.name === name);
  if (task === undefined) {
    error(`Task not found: ${sanitizeTerminalText(name)}`);
    process.exitCode = 1;
    return undefined;
  }
  const workflowIdentifier = task.data
    ? resolveTaskWorkflowValue(task.data as Record<string, unknown>)
    : undefined;
  if (!workflowIdentifier) {
    error(`Task "${sanitizeTerminalText(name)}" is missing its workflow.`);
    process.exitCode = 1;
    return undefined;
  }
  const lookupCwd = resolveLookupCwd(projectDir, task);
  const workflow = loadWorkflowByIdentifier(workflowIdentifier, projectDir, { lookupCwd });
  if (!workflow) {
    error(`Workflow "${sanitizeTerminalText(workflowIdentifier)}" is unavailable.`);
    process.exitCode = 1;
    return undefined;
  }

  const runSlug = resolveRetryRunSlug(task, lookupCwd);
  const pointer = resolveTaskPointer(task, lookupCwd, runSlug);
  return {
    task,
    workflowIdentifier,
    workflow,
    lookupCwd,
    ...(runSlug === null ? {} : { runSlug }),
    ...(pointer === undefined ? {} : { pointer }),
  };
}
