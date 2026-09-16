import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../shared/ui/index.js', () => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

import { info, success, error as logError } from '../shared/ui/index.js';
import { configureTasks } from '../features/tasks/fork/configureTasks.js';

const mockInfo = vi.mocked(info);
const mockSuccess = vi.mocked(success);
const mockLogError = vi.mocked(logError);

let tmpDir: string;

function writeConfig(body: string): string {
  const configPath = path.join(tmpDir, '.takt', 'config.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, body, 'utf-8');
  return configPath;
}

function readConfig(): Record<string, unknown> {
  return parseYaml(fs.readFileSync(path.join(tmpDir, '.takt', 'config.yaml'), 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-task-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('configureTasks', () => {
  it('should set tasks_artifacts_dir in the project config', () => {
    writeConfig('provider: mock\n');

    configureTasks(tmpDir, { tasksArtifactsDir: 'syncthing/docs/project/tasks' });

    expect(readConfig().tasks_artifacts_dir).toBe('syncthing/docs/project/tasks');
    expect(mockSuccess).toHaveBeenCalledWith('Set tasks_artifacts_dir: syncthing/docs/project/tasks');
    expect(process.exitCode).toBeUndefined();
  });

  it('should keep the other keys of the config', () => {
    writeConfig('provider: mock\nmodel: test-model\n');

    configureTasks(tmpDir, { tasksArtifactsDir: 'docs/tasks' });

    const config = readConfig();
    expect(config.provider).toBe('mock');
    expect(config.model).toBe('test-model');
  });

  it('should strip a trailing slash', () => {
    writeConfig('provider: mock\n');

    configureTasks(tmpDir, { tasksArtifactsDir: 'docs/tasks/' });

    expect(readConfig().tasks_artifacts_dir).toBe('docs/tasks');
  });

  it('should print the current value without options and change nothing', () => {
    const configPath = writeConfig('provider: mock\ntasks_artifacts_dir: docs/tasks\n');
    const before = fs.readFileSync(configPath, 'utf-8');

    configureTasks(tmpDir, {});

    expect(mockInfo).toHaveBeenCalledWith('tasks_artifacts_dir: docs/tasks');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('should report an unset value as such', () => {
    writeConfig('provider: mock\n');

    configureTasks(tmpDir, {});

    expect(mockInfo).toHaveBeenCalledWith('tasks_artifacts_dir: (not set)');
  });

  it('should clear the key for an empty value', () => {
    writeConfig('provider: mock\ntasks_artifacts_dir: docs/tasks\n');

    configureTasks(tmpDir, { tasksArtifactsDir: '' });

    expect(readConfig().tasks_artifacts_dir).toBeUndefined();
    expect(mockSuccess).toHaveBeenCalledWith('Cleared tasks_artifacts_dir.');
  });

  it('should refuse an absolute path without writing', () => {
    const configPath = writeConfig('provider: mock\n');
    const before = fs.readFileSync(configPath, 'utf-8');

    configureTasks(tmpDir, { tasksArtifactsDir: '/etc/tasks' });

    expect(mockLogError).toHaveBeenCalledWith(
      'Invalid --tasks-artifacts-dir "/etc/tasks": it must be relative to the project directory.',
    );
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('should refuse a path that escapes the project', () => {
    writeConfig('provider: mock\n');

    configureTasks(tmpDir, { tasksArtifactsDir: '../outside' });

    expect(mockLogError).toHaveBeenCalledWith(
      'Invalid --tasks-artifacts-dir "../outside": it must not contain "." or ".." path segments.',
    );
    expect(process.exitCode).toBe(1);
  });
});
