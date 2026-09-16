import { describe, it, expect, vi } from 'vitest';

const { mockResolveWorkflowCallTarget } = vi.hoisted(() => ({
  mockResolveWorkflowCallTarget: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

import type { WorkflowConfig } from '../core/models/index.js';
import {
  formatRestartPointPath,
  resolveTaskRewindRestartPoint,
} from '../features/tasks/restart/stepSelector.js';
import { makeStep } from './engine-test-helpers.js';

const context = { projectCwd: '/project', lookupCwd: '/project' };

const child: WorkflowConfig = {
  name: 'consult-review',
  description: 'Callable child',
  initialStep: 'read',
  maxSteps: 4,
  subworkflow: { callable: true },
  steps: [makeStep('read'), makeStep('decide')],
};

/** The child is called twice, so every one of its steps is ambiguous by name. */
const root: WorkflowConfig = {
  name: 'root',
  description: 'Root calling one child twice',
  initialStep: 'plan',
  maxSteps: 12,
  steps: [
    makeStep('plan'),
    makeStep('first', { kind: 'workflow_call', call: 'review/consult-review' }),
    makeStep('second', { kind: 'workflow_call', call: 'review/consult-review' }),
  ],
};

function resolve(step: string, workflow?: string) {
  mockResolveWorkflowCallTarget.mockReturnValue(child);
  return resolveTaskRewindRestartPoint(
    root,
    step,
    context,
    workflow === undefined ? {} : { workflow },
  );
}

function path(step: string, workflow?: string): string {
  return formatRestartPointPath(resolve(step, workflow));
}

describe('resolveTaskRewindRestartPoint', () => {
  it('should resolve an unambiguous root step', () => {
    expect(path('plan')).toBe('root/plan');
  });

  it('should reject a step no authored leaf carries', () => {
    expect(() => resolve('missing')).toThrow('has no authored restart step "missing"');
  });

  it('should reject an empty step', () => {
    expect(() => resolve('   ')).toThrow('Task rewind requires a non-empty step.');
  });

  it('should reject a path with an empty segment', () => {
    expect(() => resolve('first > ')).toThrow('is not a valid step path');
  });

  // The defect this covers: the ambiguity error used to print full paths that
  // the selector itself refused, leaving the user nothing to type.
  it('should accept every choice its own ambiguity error suggests', () => {
    let suggested: string[] = [];
    try {
      resolve('read');
      expect.unreachable('ambiguous step should throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('is ambiguous; choose one of:');
      suggested = [...message.matchAll(/"([^"]+\/[^"]+)"/gu)].map((match) => match[1]!);
    }

    expect(suggested).toEqual([
      'root/first > consult-review/read',
      'root/second > consult-review/read',
    ]);
    for (const choice of suggested) {
      expect(path(choice)).toBe(choice);
    }
  });

  it('should treat a path as a suffix match, so naming the caller is enough', () => {
    expect(path('second > read')).toBe('root/second > consult-review/read');
    expect(path('first > consult-review/decide')).toBe('root/first > consult-review/decide');
  });

  it('should stay ambiguous when a workflow is called twice and only it is named', () => {
    expect(() => resolve('consult-review/read')).toThrow('is ambiguous');
  });

  it('should narrow by --workflow without changing what runs', () => {
    expect(path('plan', 'root')).toBe('root/plan');
  });

  // A workflow is addressed by identifier, which is folder-qualified when its
  // YAML sits in a category subdirectory; the restart entry only knows the name.
  it('should accept the identifier the root workflow was loaded by', () => {
    mockResolveWorkflowCallTarget.mockReturnValue(child);
    const restartPoint = resolveTaskRewindRestartPoint(root, 'plan', context, {
      workflow: 'category/root',
      rootIdentifier: 'category/root',
    });

    expect(formatRestartPointPath(restartPoint)).toBe('root/plan');
  });

  it('should accept a folder-qualified identifier for a called workflow', () => {
    expect(path('first > read', 'review/consult-review'))
      .toBe('root/first > consult-review/read');
  });

  it('should accept a folder-qualified workflow inside a --step path', () => {
    expect(path('first > review/consult-review/read'))
      .toBe('root/first > consult-review/read');
  });

  it('should reject a workflow unreachable from the root workflow', () => {
    expect(() => resolve('read', 'elsewhere')).toThrow(
      /"elsewhere" is not reachable from "root"; reachable workflows: "root", "consult-review"\./u,
    );
  });

  it('should reject a step that is not in the workflow named by --workflow', () => {
    expect(() => resolve('plan', 'consult-review')).toThrow('has no authored restart step "plan"');
  });
});
