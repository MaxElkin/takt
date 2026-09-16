import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { TaskRunner } from '../../../infra/task/index.js';
import { findOrphanDirectories } from './orphanDirectories.js';
import { formatBytes } from './taskRunDirectories.js';
import { confirm } from '../../../shared/prompt/index.js';
import { info, success, error as logError } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/index.js';

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Fork: task prune command handler: delete every run directory and task
 * directory no task in `tasks.yaml` accounts for, after one confirmation.
 *
 * `takt task delete` removes a task's own runs; this removes what earlier
 * deletes, interactive runs and `takt exec` left behind. Nothing a queued task
 * claims is touched, so it is safe to run with tasks queued or running.
 */
export async function pruneOrphans(cwd: string): Promise<void> {
  const tasks = new TaskRunner(cwd).listAllTaskItems();
  const orphans = findOrphanDirectories(cwd, tasks);
  if (orphans.liveRuns > 0) {
    info(`Keeping ${plural(orphans.liveRuns, 'run')} still marked running.`);
  }

  const parts = [
    ...(orphans.runs.length > 0 ? [plural(orphans.runs.length, 'orphan run')] : []),
    ...(orphans.taskDirs.length > 0
      ? [plural(orphans.taskDirs.length, 'orphan task directory', 'orphan task directories')]
      : []),
  ];
  if (parts.length === 0) {
    info('Nothing to prune.');
    return;
  }
  const question = `Delete ${parts.join(' and ')} (${formatBytes(orphans.bytes)})?`;
  if (!(await confirm(question, false))) {
    info('Cancelled.');
    return;
  }

  let deleted = 0;
  for (const path of [
    ...orphans.runs.map((slug) => join(cwd, '.takt', 'runs', slug)),
    ...orphans.taskDirs.map((dir) => join(cwd, dir)),
  ]) {
    try {
      rmSync(path, { recursive: true, force: true });
      deleted += 1;
    } catch (err) {
      logError(`Failed to delete "${path}": ${getErrorMessage(err)}`);
      process.exitCode = 1;
    }
  }
  success(`Pruned ${plural(deleted, 'directory', 'directories')}.`);
}
