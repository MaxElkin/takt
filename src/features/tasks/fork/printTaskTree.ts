/**
 * Fork: `takt task tree` command handler.
 *
 * The task, its workflow and its pointer come from taskPointer.ts, which reads
 * the pointer the way `takt task resume` does - so the step this prints as
 * current is the step a resume would continue from, and the step
 * `takt task instruction` prints the prompt for.
 */

import { sanitizeTerminalText } from '../../../shared/utils/index.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { TASK_STATUS_BY_KIND } from '../list/taskStatusLabel.js';
import { locateTask } from './taskPointer.js';
import { formatTaskTreeView, renderTaskTree } from './taskTree.js';

function buildStatusLine(task: TaskListItem): string {
  const status = TASK_STATUS_BY_KIND[task.kind];
  if (task.failure === undefined) {
    return status;
  }
  const at = task.failure.step === undefined ? '' : ` at ${task.failure.step}`;
  return `${status}${at} — ${sanitizeTerminalText(task.failure.error)}`;
}

export function printTaskTree(
  projectDir: string,
  name: string,
  options: { full?: boolean } = {},
): void {
  const located = locateTask(projectDir, name);
  if (located === undefined) {
    return;
  }

  const view = renderTaskTree({
    taskName: located.task.name,
    workflowIdentifier: located.workflowIdentifier,
    status: buildStatusLine(located.task),
    rootWorkflow: located.workflow,
    context: { projectCwd: projectDir, lookupCwd: located.lookupCwd },
    ...(located.pointer === undefined ? {} : { pointer: located.pointer }),
    ...(options.full === true ? { full: true } : {}),
  });

  console.log(formatTaskTreeView(view));
}
