import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { readRunMeta } from '../../../core/workflow/run/run-meta.js';
import type { TaskListItem } from '../../../infra/task/types.js';

/** A chain longer than this means a cycle or a corrupt meta; stop walking. */
const MAX_CHAIN_LENGTH = 64;

export interface TaskRunDirectories {
  /** Run slugs that belong to this task and no other. */
  readonly slugs: readonly string[];
  /** Total size on disk of those runs, in bytes. */
  readonly bytes: number;
  /** A chain link could not be read, so the list may be short. */
  readonly incomplete: boolean;
}

function runsDirectory(projectDir: string): string {
  return join(projectDir, '.takt', 'runs');
}

function readSourceRunSlug(runsDir: string, slug: string): {
  readonly sourceRunSlug?: string;
  readonly readable: boolean;
} {
  try {
    const meta = readRunMeta(join(runsDir, slug, 'meta.json'));
    if (meta === null) {
      return { readable: false };
    }
    return {
      readable: true,
      ...(meta.sourceRunSlug === undefined ? {} : { sourceRunSlug: meta.sourceRunSlug }),
    };
  } catch {
    return { readable: false };
  }
}

/**
 * Walk `source_run_slug` backwards from `startSlug`, collecting the chain.
 *
 * This is how a run was matched to its task before runs carried `task_dir`,
 * and it stays the fallback for every run created before that stamp existed
 * and for a task whose text is carried by `content` or `content_file` rather
 * than a task directory.
 */
function walkChain(
  runsDir: string,
  startSlug: string | undefined,
  into: Set<string>,
): boolean {
  let complete = true;
  let slug = startSlug;
  while (slug !== undefined && !into.has(slug) && into.size <= MAX_CHAIN_LENGTH) {
    // Read before collecting: a slug whose run is missing or whose meta is
    // corrupt is not proven to belong to this task, so it must not end up in
    // a list the caller deletes.
    const meta = readSourceRunSlug(runsDir, slug);
    if (!meta.readable) {
      complete = false;
      break;
    }
    into.add(slug);
    slug = meta.sourceRunSlug;
  }
  return complete;
}

export function directorySize(path: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry);
    try {
      const stats = statSync(child);
      total += stats.isDirectory() ? directorySize(child) : stats.size;
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total;
}

/**
 * Every run directory that belongs to `task`, by both identification routes:
 * the `task_dir` stamp a run carries, and the resume chain for runs written
 * before the stamp existed.
 *
 * A run any *other* task still points at is never returned, so a slug reused
 * across tasks - or a chain a second task was branched from - cannot take a
 * live run down with it.
 */
export function findTaskRunDirectories(
  projectDir: string,
  task: TaskListItem,
  otherTasks: readonly TaskListItem[],
): TaskRunDirectories {
  const runsDir = runsDirectory(projectDir);
  const mine = new Set<string>();
  const complete = walkChain(runsDir, task.runSlug, mine);

  if (task.taskDir !== undefined) {
    let entries: string[] = [];
    try {
      entries = readdirSync(runsDir);
    } catch {
      entries = [];
    }
    for (const slug of entries) {
      try {
        const meta = readRunMeta(join(runsDir, slug, 'meta.json'));
        if (meta?.taskDir === task.taskDir) {
          mine.add(slug);
        }
      } catch {
        // Unreadable meta: the chain walk is the fallback for this run.
      }
    }
  }

  const reserved = new Set<string>();
  for (const other of otherTasks) {
    walkChain(runsDir, other.runSlug, reserved);
  }

  const slugs = [...mine].filter((slug) => !reserved.has(slug)).sort();
  const bytes = slugs.reduce(
    (total, slug) => total + directorySize(join(runsDir, slug)),
    0,
  );
  return { slugs, bytes, incomplete: !complete };
}

/**
 * Every run slug claimed by any of `tasks`, by both identification routes.
 *
 * `findTaskRunDirectories` answers "which runs are this task's alone"; this
 * answers "which runs have an owner at all", which is what tells an orphan
 * from a run still attached to a queued task.
 */
export function collectClaimedRunSlugs(
  projectDir: string,
  tasks: readonly TaskListItem[],
): Set<string> {
  const runsDir = runsDirectory(projectDir);
  const claimed = new Set<string>();
  const claimedTaskDirs = new Set(
    tasks.flatMap((task) => (task.taskDir === undefined ? [] : [task.taskDir])),
  );
  for (const task of tasks) {
    walkChain(runsDir, task.runSlug, claimed);
  }
  if (claimedTaskDirs.size > 0) {
    for (const slug of readDirectoryNames(runsDir)) {
      try {
        const meta = readRunMeta(join(runsDir, slug, 'meta.json'));
        if (meta?.taskDir !== undefined && claimedTaskDirs.has(meta.taskDir)) {
          claimed.add(slug);
        }
      } catch {
        // Unreadable meta: the chain walk is the only route for this run.
      }
    }
  }
  return claimed;
}

/** Directory entries of `path` that are themselves directories. */
export function readDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
