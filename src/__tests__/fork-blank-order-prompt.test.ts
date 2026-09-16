import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTaskSpecForExecution } from '../features/tasks/execute/taskSpecContext.js';

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takt-fork-blank-order-'));
  tempRoots.add(root);
  return root;
}

const TASK_DIR = '.takt/tasks/spec-task';

function resolveWithOrder(orderContent: string): string {
  const projectCwd = createTempDir();
  const execCwd = createTempDir();
  const sourceTaskDir = path.join(projectCwd, TASK_DIR);
  fs.mkdirSync(sourceTaskDir, { recursive: true });
  fs.writeFileSync(path.join(sourceTaskDir, 'order.md'), orderContent, 'utf-8');

  return resolveTaskSpecForExecution(projectCwd, execCwd, TASK_DIR, '20260916-spec-task').taskPrompt;
}

describe('resolveTaskSpecForExecution with a blank order', () => {
  // The prompt lands under `## User Request`, above the step instruction under
  // `## Work`. Announcing an empty file as the primary spec makes the step
  // interrogate it instead of doing the authored work.
  it.each([
    ['an empty order', ''],
    ['a whitespace-only order', '\n  \n\t\n'],
  ])('should not name order.md as the primary spec for %s', (_case, orderContent) => {
    const taskPrompt = resolveWithOrder(orderContent);

    expect(taskPrompt).not.toContain('order.md');
    expect(taskPrompt).not.toContain('Primary spec');
    expect(taskPrompt).not.toContain('Implement using only the files');
    expect(taskPrompt).toContain('No task specification was supplied for this run.');
    expect(taskPrompt).toContain('The workflow step instructions below define the work in full');
  });

  it('should keep the upstream prompt when the order carries a specification', () => {
    const taskPrompt = resolveWithOrder('# Task\n\nImplement exactly this.');

    expect(taskPrompt).toContain('Implement using only the files');
    expect(taskPrompt).toContain('.takt/runs/20260916-spec-task/context/task/order.md');
  });
});
