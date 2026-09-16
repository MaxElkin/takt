import { describe, it, expect } from 'vitest';
import {
  MISSING_TASK_ARTIFACTS_DIR,
  replaceTaskArtifactsDirPlaceholder,
  resolveTaskArtifactsDir,
  validateTasksArtifactsDir,
} from '../core/workflow/instruction/fork/taskArtifactsDir.js';

describe('validateTasksArtifactsDir', () => {
  it.each([
    'syncthing/docs/project/tasks',
    'docs',
    'a/b/c/d',
  ])('should accept the project-relative path %s', (dir) => {
    expect(validateTasksArtifactsDir(dir)).toBeUndefined();
  });

  it.each([
    ['/abs/tasks', 'must be relative to the project directory'],
    ['C:/tasks', 'must be relative to the project directory'],
    ['docs\\tasks', 'must use "/" as the path separator'],
    ['docs//tasks', 'must not contain an empty path segment'],
    ['docs/../../etc', 'must not contain "." or ".." path segments'],
    ['./docs', 'must not contain "." or ".." path segments'],
    [' docs', 'must not have leading or trailing whitespace'],
    ['', 'must not be empty'],
  ])('should reject %s', (dir, reason) => {
    expect(validateTasksArtifactsDir(dir)).toBe(reason);
  });

  it('should accept a trailing slash, which the resolver strips', () => {
    expect(validateTasksArtifactsDir('docs/tasks/')).toBeUndefined();
    expect(resolveTaskArtifactsDir('docs/tasks/', 'kek')).toBe('docs/tasks/kek');
  });
});

describe('resolveTaskArtifactsDir', () => {
  it('should join the configured parent with the slugified task name', () => {
    expect(resolveTaskArtifactsDir('syncthing/docs/project/tasks', 'kek'))
      .toBe('syncthing/docs/project/tasks/kek');
  });

  it('should slugify a name that is not already a slug', () => {
    expect(resolveTaskArtifactsDir('docs/tasks', 'Task With Spaces'))
      .toBe('docs/tasks/task-with-spaces');
  });

  it.each([
    ['no configured parent', undefined, 'kek'],
    ['an invalid configured parent', '/abs', 'kek'],
    ['no task name', 'docs/tasks', undefined],
    ['a name that slugifies to nothing', 'docs/tasks', '日本語'],
  ])('should resolve nothing for %s', (_case, dir, name) => {
    expect(resolveTaskArtifactsDir(dir, name)).toBeUndefined();
  });
});

describe('replaceTaskArtifactsDirPlaceholder', () => {
  it('should replace every occurrence with the resolved directory', () => {
    expect(replaceTaskArtifactsDirPlaceholder(
      'Read {task_artifacts_dir}, then write {task_artifacts_dir}/notes.md',
      'docs/tasks/kek',
    )).toBe('Read docs/tasks/kek, then write docs/tasks/kek/notes.md');
  });

  it('should degrade to a notice rather than an empty path when unresolved', () => {
    expect(replaceTaskArtifactsDirPlaceholder('Read {task_artifacts_dir}.', undefined))
      .toBe(`Read ${MISSING_TASK_ARTIFACTS_DIR}.`);
  });

  it('should leave a template without the placeholder untouched', () => {
    expect(replaceTaskArtifactsDirPlaceholder('No placeholder here.', 'docs/tasks/kek'))
      .toBe('No placeholder here.');
  });
});
