import { describe, it, expect, vi } from 'vitest';

const { mockResolveWorkflowCallTarget } = vi.hoisted(() => ({
  mockResolveWorkflowCallTarget: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

import type { WorkflowConfig } from '../core/models/index.js';
import {
  formatWorkflowTreeView,
  renderWorkflowTree,
} from '../features/tasks/fork/workflowTree.js';
import { makeStep } from './engine-test-helpers.js';

const context = { projectCwd: '/project', lookupCwd: '/project' };

const gates: WorkflowConfig = {
  name: 'gates',
  description: 'Deepest child',
  initialStep: 'lint',
  maxSteps: 4,
  subworkflow: { callable: true },
  steps: [makeStep('lint'), makeStep('test'), makeStep('build')],
};

const codeChange: WorkflowConfig = {
  name: 'code-change',
  description: 'Middle child',
  initialStep: 'draft',
  maxSteps: 8,
  subworkflow: { callable: true },
  steps: [
    makeStep('draft'),
    makeStep('verify', { kind: 'workflow_call', call: 'qa/gates' }),
  ],
};

const root: WorkflowConfig = {
  name: 'full',
  description: 'Root workflow',
  initialStep: 'plan',
  maxSteps: 20,
  steps: [
    makeStep('plan'),
    makeStep('implement', { kind: 'workflow_call', call: 'impl/code-change' }),
    makeStep('ship'),
  ],
};

function resolveCall(_parent: WorkflowConfig, step: { call: string }): WorkflowConfig | null {
  if (step.call === 'impl/code-change') return codeChange;
  if (step.call === 'qa/gates') return gates;
  return null;
}

function render(full?: boolean) {
  mockResolveWorkflowCallTarget.mockImplementation(resolveCall);
  return renderWorkflowTree({
    workflowIdentifier: 'pipeline/full',
    rootWorkflow: root,
    context,
    ...(full === true ? { full: true } : {}),
  });
}

describe('renderWorkflowTree', () => {
  // No run exists, so no branch is on a path: every call collapses, and the
  // count is recursive - code-change's 1 own step plus gates' 3.
  it('should collapse every subworkflow by default', () => {
    expect([...render().tree]).toEqual([
      'pipeline/full',
      '├─ plan  ◀ initial',
      '├─ implement → impl/code-change',
      '│  └─ … 4 steps',
      '└─ ship',
    ]);
  });

  it('should expand every subworkflow when full is set', () => {
    expect([...render(true).tree]).toEqual([
      'pipeline/full',
      '├─ plan  ◀ initial',
      '├─ implement → impl/code-change',
      '│  ├─ draft',
      '│  └─ verify → qa/gates',
      '│     ├─ lint',
      '│     ├─ test',
      '│     └─ build',
      '└─ ship',
    ]);
  });

  it('should head the view with the workflow, its description and a recursive step count', () => {
    expect([...render().header]).toEqual([
      'Workflow:    pipeline/full',
      'Description: Root workflow',
      'Steps:       6 selectable',
    ]);
  });

  it('should print the header and tree separated by a blank line', () => {
    const text = formatWorkflowTreeView(render());

    expect(text.split('\n')[3]).toBe('');
    expect(text).toContain('│  └─ … 4 steps');
    expect(text).not.toContain('--step');
  });

  it('should note a call it cannot resolve instead of dropping the branch', () => {
    mockResolveWorkflowCallTarget.mockReturnValue(null);

    const lines = [...renderWorkflowTree({
      workflowIdentifier: 'pipeline/full',
      rootWorkflow: root,
      context,
    }).tree];

    expect(lines.some((line) => line.includes('… unavailable:'))).toBe(true);
    expect(lines).toContain('└─ ship');
  });
});
