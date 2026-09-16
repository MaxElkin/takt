import { join } from 'node:path';

import { readRunMeta } from '../../../core/workflow/run/run-meta.js';
import type { TaskListItem } from '../../../infra/task/types.js';
import {
  collectClaimedRunSlugs,
  directorySize,
  readDirectoryNames,
} from './taskRunDirectories.js';

export interface OrphanDirectories {
  /** Run slugs under `.takt/runs` no queued task claims. */
  readonly runs: readonly string[];
  /** Task directories, project-relative, no queued task points at. */
  readonly taskDirs: readonly string[];
  /** Total size on disk of both lists, in bytes. */
  readonly bytes: number;
  /** Unclaimed runs left alone because their `meta.json` says `running`. */
  readonly liveRuns: number;
}

/**
 * Everything under `.takt/runs` and `.takt/tasks` that no record in
 * `tasks.yaml` accounts for.
 *
 * A run is claimed the same two ways `findTaskRunDirectories` claims one - the
 * `task_dir` stamp and the resume chain - so what is left over is a run whose
 * task was deleted before runs were deleted with it, an interactive or
 * `takt exec` run, or a `debug-*` directory. A run whose `meta.json` is
 * missing or corrupt is unattributable and counts as an orphan; a run whose
 * meta says it is still `running` is kept, because an interactive run in
 * progress claims no task and is not garbage.
 */
export function findOrphanDirectories(
  projectDir: string,
  tasks: readonly TaskListItem[],
): OrphanDirectories {
  const runsDir = join(projectDir, '.takt', 'runs');
  const claimed = collectClaimedRunSlugs(projectDir, tasks);
  const runs: string[] = [];
  let liveRuns = 0;
  for (const slug of readDirectoryNames(runsDir)) {
    if (claimed.has(slug)) {
      continue;
    }
    if (isRunning(join(runsDir, slug, 'meta.json'))) {
      liveRuns += 1;
      continue;
    }
    runs.push(slug);
  }

  const claimedTaskDirs = new Set(
    tasks.flatMap((task) => (task.taskDir === undefined ? [] : [task.taskDir])),
  );
  const taskDirs = readDirectoryNames(join(projectDir, '.takt', 'tasks'))
    .map((name) => `.takt/tasks/${name}`)
    .filter((dir) => !claimedTaskDirs.has(dir));

  const bytes = [
    ...runs.map((slug) => join(runsDir, slug)),
    ...taskDirs.map((dir) => join(projectDir, dir)),
  ].reduce((total, path) => total + directorySize(path), 0);

  return { runs: runs.sort(), taskDirs: taskDirs.sort(), bytes, liveRuns };
}

function isRunning(metaPath: string): boolean {
  try {
    return readRunMeta(metaPath)?.status === 'running';
  } catch {
    return false;
  }
}
