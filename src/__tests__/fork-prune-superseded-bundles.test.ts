import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pruneSupersededRunBundles } from '../features/tasks/execute/fork/pruneSupersededRunBundles.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';

let projectDir: string;

function runsDir(): string {
  return join(projectDir, '.takt', 'runs');
}

function writeRun(slug: string, sourceRunSlug?: string): void {
  const runRoot = join(runsDir(), slug);
  mkdirSync(join(runRoot, 'workflow-bundle', 'objects'), { recursive: true });
  mkdirSync(join(runRoot, 'reports'), { recursive: true });
  writeFileSync(join(runRoot, 'workflow-bundle', 'manifest.json'), '{}');
  writeFileSync(join(runRoot, 'reports', 'report.md'), 'kept');
  writeFileSync(join(runRoot, 'trace.md'), 'kept');
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
    ...(sourceRunSlug === undefined ? {} : { source_run_slug: sourceRunSlug }),
  }));
}

function runPathsFor(slug: string): RunPaths {
  return { slug, runRootAbs: join(runsDir(), slug) } as RunPaths;
}

function hasBundle(slug: string): boolean {
  return existsSync(join(runsDir(), slug, 'workflow-bundle'));
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'takt-prune-'));
  mkdirSync(runsDir(), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('pruneSupersededRunBundles (fork)', () => {
  it('removes the bundle of every ancestor and keeps the live run', () => {
    writeRun('run-a');
    writeRun('run-b', 'run-a');
    writeRun('run-c', 'run-b');

    pruneSupersededRunBundles(runPathsFor('run-c'), 'run-b');

    expect(hasBundle('run-a')).toBe(false);
    expect(hasBundle('run-b')).toBe(false);
    expect(hasBundle('run-c')).toBe(true);
  });

  it('keeps the history of a pruned run', () => {
    writeRun('run-a');
    writeRun('run-b', 'run-a');

    pruneSupersededRunBundles(runPathsFor('run-b'), 'run-a');

    expect(existsSync(join(runsDir(), 'run-a', 'meta.json'))).toBe(true);
    expect(existsSync(join(runsDir(), 'run-a', 'reports', 'report.md'))).toBe(true);
    expect(existsSync(join(runsDir(), 'run-a', 'trace.md'))).toBe(true);
  });

  it('does nothing for a first run, which has no source', () => {
    writeRun('run-a');

    pruneSupersededRunBundles(runPathsFor('run-a'), undefined);

    expect(hasBundle('run-a')).toBe(true);
  });

  it('stops at a missing ancestor instead of throwing', () => {
    writeRun('run-b', 'gone');

    expect(() => pruneSupersededRunBundles(runPathsFor('run-c'), 'run-b')).not.toThrow();
    expect(hasBundle('run-b')).toBe(false);
  });

  it('terminates when the chain points at itself', () => {
    writeRun('run-a', 'run-a');

    expect(() => pruneSupersededRunBundles(runPathsFor('run-b'), 'run-a')).not.toThrow();
    expect(hasBundle('run-a')).toBe(false);
  });
});
