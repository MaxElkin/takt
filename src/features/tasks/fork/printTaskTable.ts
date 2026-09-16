import { TaskRunner } from '../../../infra/task/index.js';
import { info } from '../../../shared/ui/index.js';
import { TASK_STATUS_BY_KIND } from '../list/taskStatusLabel.js';
import { loadCurrentTaskName } from './currentTask.js';
import { MARKER_CURRENT } from './taskTree.js';

/**
 * Fork: task list command handler: print every task as a name / status / workflow table.
 *
 * The task `--current` resolves to carries the same marker `takt task tree`
 * puts on the current step, so the list answers "which one is that" without a
 * second command. A `current_task` naming no task simply marks nothing: the
 * stale key is reported when something actually tries to use it.
 */
export function printTaskTable(cwd: string): void {
  const tasks = new TaskRunner(cwd).listAllTaskItems();
  if (tasks.length === 0) {
    info('No tasks to list.');
    return;
  }

  const current = loadCurrentTaskName(cwd);
  const rows = [
    ['NAME', 'STATUS', 'WORKFLOW', ''],
    ...tasks.map((task) => [
      task.name,
      TASK_STATUS_BY_KIND[task.kind],
      task.data?.workflow ?? '-',
      task.name === current ? MARKER_CURRENT : '',
    ]),
  ];
  const widths = [0, 1, 2].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
  for (const [name, status, workflow, marker] of rows) {
    console.log(
      `${name!.padEnd(widths[0]!)}  ${status!.padEnd(widths[1]!)}  ${workflow!.padEnd(widths[2]!)}  ${marker}`
        .trimEnd(),
    );
  }
}
