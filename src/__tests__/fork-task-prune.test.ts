import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/prompt/index.js', () => ({
  confirm: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

import { confirm } from '../shared/prompt/index.js';
import { info, success } from '../shared/ui/index.js';
import { pruneOrphans } from '../features/tasks/fork/pruneOrphans.js';

const mockConfirm = vi.mocked(confirm);
const mockInfo = vi.mocked(info);
const mockSuccess = vi.mocked(success);

let tmpDir: string;

const KEPT_TASK_DIR = '.takt/tasks/20260916-101431-kept';

function writeRun(slug: string, meta: Record<string, unknown>): void {
  const runRoot = path.join(tmpDir, '.takt', 'runs', slug);
  fs.mkdirSync(runRoot, { recursive: true });
  fs.writeFileSync(path.join(runRoot, 'meta.json'), JSON.stringify({
    task: 'probe',
    workflow: 'probe',
    runSlug: slug,
    runRoot: `.takt/runs/${slug}`,
    reportDirectory: `.takt/runs/${slug}/reports`,
    contextDirectory: `.takt/runs/${slug}/context`,
    logsDirectory: `.takt/runs/${slug}/logs`,
    status: 'failed',
    startTime: '2026-09-16T09:00:00.000Z',
    ...meta,
  }), 'utf-8');
}

function writeTaskDir(dir: string): void {
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, dir, 'order.md'), 'order', 'utf-8');
}

function writeTasksFile(tasks: readonly Record<string, unknown>[]): void {
  const tasksFile = path.join(tmpDir, '.takt', 'tasks.yaml');
  fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
  fs.writeFileSync(tasksFile, stringifyYaml({ tasks }), 'utf-8');
}

function keptTaskRecord(runSlug: string): Record<string, unknown> {
  return {
    name: 'kept',
    status: 'failed',
    task_dir: KEPT_TASK_DIR,
    run_slug: runSlug,
    failure: { error: 'probe failed' },
    created_at: '2026-09-16T09:00:00.000Z',
    started_at: '2026-09-16T09:00:01.000Z',
    completed_at: '2026-09-16T09:00:02.000Z',
  };
}

function exists(...segments: string[]): boolean {
  return fs.existsSync(path.join(tmpDir, ...segments));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-task-prune-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('pruneOrphans', () => {
  it('should delete only what no task accounts for', async () => {
    writeTaskDir(KEPT_TASK_DIR);
    writeTaskDir('.takt/tasks/20260916-101431-orphan');
    writeRun('kept-run', { task_dir: KEPT_TASK_DIR });
    writeRun('kept-ancestor', { task_dir: KEPT_TASK_DIR });
    writeRun('orphan-run', {});
    writeTasksFile([keptTaskRecord('kept-run')]);

    await pruneOrphans(tmpDir);

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Delete 1 orphan run and 1 orphan task directory \(\d+ B\)\?$/,
      ),
      false,
    );
    expect(exists('.takt', 'runs', 'kept-run')).toBe(true);
    expect(exists('.takt', 'runs', 'kept-ancestor')).toBe(true);
    expect(exists(KEPT_TASK_DIR)).toBe(true);
    expect(exists('.takt', 'runs', 'orphan-run')).toBe(false);
    expect(exists('.takt/tasks/20260916-101431-orphan')).toBe(false);
    expect(mockSuccess).toHaveBeenCalledWith('Pruned 2 directories.');
    expect(process.exitCode).toBeUndefined();
  });

  it('should keep a run the resume chain claims for a task without a task directory', async () => {
    writeRun('chain-head', { source_run_slug: 'chain-tail' });
    writeRun('chain-tail', {});
    writeRun('orphan-run', {});
    writeTasksFile([{
      name: 'chained',
      status: 'failed',
      content: 'chained',
      run_slug: 'chain-head',
      failure: { error: 'probe failed' },
      created_at: '2026-09-16T09:00:00.000Z',
      started_at: '2026-09-16T09:00:01.000Z',
      completed_at: '2026-09-16T09:00:02.000Z',
    }]);

    await pruneOrphans(tmpDir);

    expect(exists('.takt', 'runs', 'chain-head')).toBe(true);
    expect(exists('.takt', 'runs', 'chain-tail')).toBe(true);
    expect(exists('.takt', 'runs', 'orphan-run')).toBe(false);
  });

  it('should keep an unclaimed run that is still marked running', async () => {
    writeRun('live-run', { status: 'running' });
    writeTasksFile([]);

    await pruneOrphans(tmpDir);

    expect(mockInfo).toHaveBeenCalledWith('Keeping 1 run still marked running.');
    expect(mockInfo).toHaveBeenCalledWith('Nothing to prune.');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(exists('.takt', 'runs', 'live-run')).toBe(true);
  });

  it('should delete a run whose meta cannot be read', async () => {
    fs.mkdirSync(path.join(tmpDir, '.takt', 'runs', 'corrupt-run'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.takt', 'runs', 'corrupt-run', 'meta.json'), '{ not json', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, '.takt', 'runs', 'debug-20260916'), { recursive: true });
    writeTasksFile([]);

    await pruneOrphans(tmpDir);

    expect(mockConfirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Delete 2 orphan runs \(\d+ B\)\?$/),
      false,
    );
    expect(exists('.takt', 'runs', 'corrupt-run')).toBe(false);
    expect(exists('.takt', 'runs', 'debug-20260916')).toBe(false);
  });

  it('should delete nothing when confirmation is declined', async () => {
    writeRun('orphan-run', {});
    writeTasksFile([]);
    mockConfirm.mockResolvedValue(false);

    await pruneOrphans(tmpDir);

    expect(mockInfo).toHaveBeenCalledWith('Cancelled.');
    expect(exists('.takt', 'runs', 'orphan-run')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('should report nothing to prune for a clean project', async () => {
    writeTaskDir(KEPT_TASK_DIR);
    writeRun('kept-run', { task_dir: KEPT_TASK_DIR });
    writeTasksFile([keptTaskRecord('kept-run')]);

    await pruneOrphans(tmpDir);

    expect(mockInfo).toHaveBeenCalledWith('Nothing to prune.');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSuccess).not.toHaveBeenCalled();
  });
});
