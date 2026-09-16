import { slugify } from '../../../../shared/utils/slug.js';

/**
 * Fork: `{task_artifacts_dir}` - the project-relative directory holding one
 * task's durable, git-versioned artifacts.
 *
 * The parent comes from `tasks_artifacts_dir` in `.takt/config.yaml`; the leaf
 * is the task's own name, slugified the way task slugs and branch names are.
 * The result stays project-relative on purpose: unlike `{report_dir}`, which
 * points into `.takt/runs`, this names a path inside the repository, so it has
 * to read the same in the project and in a worktree clone, and has to be a
 * path a step can hand to git.
 *
 * Nothing here creates the directory. Git does not track an empty directory,
 * so creating one per task would leave untracked litter for every task that
 * produces no artifacts; the step that writes creates it.
 */

/** Rejection reason, or undefined when the configured parent is usable. */
export function validateTasksArtifactsDir(dir: string): string | undefined {
  if (dir.trim() !== dir) {
    return 'must not have leading or trailing whitespace';
  }
  if (dir.length === 0) {
    return 'must not be empty';
  }
  if (dir.includes('\\')) {
    return 'must use "/" as the path separator';
  }
  if (dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) {
    return 'must be relative to the project directory';
  }
  const segments = dir.replace(/\/+$/, '').split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return 'must not contain an empty path segment';
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'must not contain "." or ".." path segments';
  }
  return undefined;
}

/**
 * The task's artifact directory, or undefined when there is none: no
 * configured parent, no queued task, or a task name that slugifies to nothing
 * (a name with no ASCII letters or digits).
 */
export function resolveTaskArtifactsDir(
  tasksArtifactsDir: string | undefined,
  taskName: string | undefined,
): string | undefined {
  if (tasksArtifactsDir === undefined || validateTasksArtifactsDir(tasksArtifactsDir) !== undefined) {
    return undefined;
  }
  if (taskName === undefined) {
    return undefined;
  }
  const slug = slugify(taskName);
  if (slug.length === 0) {
    return undefined;
  }
  return `${tasksArtifactsDir.replace(/\/+$/, '')}/${slug}`;
}

/**
 * What the placeholder renders when there is no directory to name.
 *
 * A run with no queued task - interactive, `takt exec`, a `takt prompt`
 * preview - still has to render its workflow, so this degrades to a sentence
 * the way a missing `{report:X}` does rather than failing the step.
 */
export const MISSING_TASK_ARTIFACTS_DIR = '(no task artifacts directory for this run)';

export function replaceTaskArtifactsDirPlaceholder(
  template: string,
  taskArtifactsDir: string | undefined,
): string {
  return template.replace(
    /\{task_artifacts_dir\}/g,
    taskArtifactsDir ?? MISSING_TASK_ARTIFACTS_DIR,
  );
}
