import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findTaskRunDirectories, formatBytes } from '../features/tasks/fork/taskRunDirectories.js';
import type { TaskListItem } from '../infra/task/types.js';

let projectDir: string;

function writeRun(slug: string, meta: Record<string, unknown>, bodyBytes = 0): void {
  const runRoot = join(projectDir, '.takt', 'runs', slug);
  mkdirSync(join(runRoot, 'reports'), { recursive: true });
  writeFileSync(join(runRoot, 'meta.json'), JSON.stringify({
    task: 'task text',
    workflow: 'consult',
    runSlug: slug,
    runRoot: `.takt/runs/${slug}`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`,
    logsDirectory: `.takt/runs/${slug}/logs`,
    status: 'failed',
    startTime: '2026-09-16T09:00:00.000Z',
    ...meta,
  }));
  if (bodyBytes > 0) {
    writeFileSync(join(runRoot, 'reports', 'report.md'), 'x'.repeat(bodyBytes));
  }
}

function task(overrides: Partial<TaskListItem>): TaskListItem {
  return {
    kind: 'failed',
    name: 'kek',
    createdAt: '2026-09-15T18:06:30.318Z',
    filePath: join(projectDir, '.takt', 'tasks.yaml'),
    content: 'kek',
    ...overrides,
  } as TaskListItem;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'takt-run-dirs-'));
  mkdirSync(join(projectDir, '.takt', 'runs'), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('findTaskRunDirectories (fork)', () => {
  it('walks the resume chain backwards from the current run', () => {
    writeRun('run-a', {});
    writeRun('run-b', { source_run_slug: 'run-a' });
    writeRun('run-c', { source_run_slug: 'run-b' });

    const found = findTaskRunDirectories(projectDir, task({ runSlug: 'run-c' }), []);

    expect(found.slugs).toEqual(['run-a', 'run-b', 'run-c']);
    expect(found.incomplete).toBe(false);
  });

  it('finds a run by its task_dir stamp even when the chain does not reach it', () => {
    writeRun('run-a', { task_dir: '.takt/tasks/20260915-180630-kek' });
    writeRun('run-b', { task_dir: '.takt/tasks/20260915-180630-kek' });
    writeRun('other', { task_dir: '.takt/tasks/20260915-175345-probe' });

    const found = findTaskRunDirectories(
      projectDir,
      task({ taskDir: '.takt/tasks/20260915-180630-kek' }),
      [],
    );

    expect(found.slugs).toEqual(['run-a', 'run-b']);
  });

  it('never returns a run another task still points at', () => {
    writeRun('shared', {});
    writeRun('mine', { source_run_slug: 'shared' });

    const found = findTaskRunDirectories(
      projectDir,
      task({ runSlug: 'mine' }),
      [task({ name: 'other', runSlug: 'shared' })],
    );

    expect(found.slugs).toEqual(['mine']);
  });

  it('reports an incomplete walk when a chain link cannot be read', () => {
    writeRun('run-b', { source_run_slug: 'missing-run' });

    const found = findTaskRunDirectories(projectDir, task({ runSlug: 'run-b' }), []);

    expect(found.slugs).toEqual(['run-b']);
    expect(found.incomplete).toBe(true);
  });

  it('measures what would be deleted', () => {
    writeRun('run-a', {}, 2048);

    const found = findTaskRunDirectories(projectDir, task({ runSlug: 'run-a' }), []);

    expect(found.bytes).toBeGreaterThan(2048);
  });

  it('returns nothing for a task that never ran', () => {
    const found = findTaskRunDirectories(projectDir, task({}), []);

    expect(found.slugs).toEqual([]);
    expect(found.bytes).toBe(0);
  });
});

describe('formatBytes (fork)', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [3_670_016, '3.5 MB'],
  ])('formats %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
