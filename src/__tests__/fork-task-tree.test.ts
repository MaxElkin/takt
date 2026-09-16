import { describe, it, expect, vi } from 'vitest';

const { mockResolveWorkflowCallTarget } = vi.hoisted(() => ({
  mockResolveWorkflowCallTarget: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

import type { WorkflowConfig } from '../core/models/index.js';
import { formatTaskTreeView, renderTaskTree } from '../features/tasks/fork/taskTree.js';
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
    makeStep('summarize'),
  ],
};

const publish: WorkflowConfig = {
  name: 'publish',
  description: 'Off-path child',
  initialStep: 'tag',
  maxSteps: 4,
  subworkflow: { callable: true },
  steps: [makeStep('tag'), makeStep('upload')],
};

const root: WorkflowConfig = {
  name: 'full',
  description: 'Root',
  initialStep: 'plan',
  maxSteps: 20,
  steps: [
    makeStep('plan'),
    makeStep('implement', { kind: 'workflow_call', call: 'impl/code-change' }),
    makeStep('ship', { kind: 'workflow_call', call: 'release/publish' }),
  ],
};

function resolveCall(_parent: WorkflowConfig, step: { call: string }): WorkflowConfig | null {
  if (step.call === 'impl/code-change') return codeChange;
  if (step.call === 'qa/gates') return gates;
  if (step.call === 'release/publish') return publish;
  return null;
}

function render(
  pointer?: readonly { workflow: string; step: string }[],
  options: { full?: boolean; status?: string } = {},
): string[] {
  mockResolveWorkflowCallTarget.mockImplementation(resolveCall);
  return [...renderTaskTree({
    taskName: 'refactor-auth',
    workflowIdentifier: 'pipeline/full',
    status: options.status ?? 'running',
    rootWorkflow: root,
    context,
    ...(pointer === undefined ? {} : { pointer }),
    ...(options.full === true ? { full: true } : {}),
  }).tree];
}

const NESTED_POINTER = [
  { workflow: 'full', step: 'implement' },
  { workflow: 'code-change', step: 'verify' },
  { workflow: 'gates', step: 'test' },
];

describe('renderTaskTree', () => {
  it('should expand only the current step branch and collapse the others', () => {
    expect(render(NESTED_POINTER)).toEqual([
      'pipeline/full',
      '├─ plan',
      '├─ implement → impl/code-change',
      '│  ├─ draft',
      '│  ├─ verify → qa/gates',
      '│  │  ├─ lint',
      '│  │  ├─ test  ◀ current',
      '│  │  └─ build',
      '│  └─ summarize',
      '└─ ship → release/publish',
      '   └─ … 2 steps',
    ]);
  });

  // The collapsed count is recursive, so it says how many steps are actually
  // hidden rather than how many the callee happens to author at its top level.
  it('should count every hidden step, however deep', () => {
    const lines = render([{ workflow: 'full', step: 'plan' }]);
    const heading = lines.findIndex((row) => row.includes('implement'));

    // code-change authors 3 steps, one of which calls gates' 3: 5 selectable.
    expect(lines[heading + 1]).toBe('│  └─ … 5 steps');
  });

  it('should expand every subworkflow when full is set', () => {
    expect(render([{ workflow: 'full', step: 'plan' }], { full: true })).toEqual([
      'pipeline/full',
      '├─ plan  ◀ current',
      '├─ implement → impl/code-change',
      '│  ├─ draft',
      '│  ├─ verify → qa/gates',
      '│  │  ├─ lint',
      '│  │  ├─ test',
      '│  │  └─ build',
      '│  └─ summarize',
      '└─ ship → release/publish',
      '   ├─ tag',
      '   └─ upload',
    ]);
  });

  it('should collapse an off-path call at depth 0 rather than peeking one level in', () => {
    expect(render([{ workflow: 'full', step: 'plan' }])).toContain('│  └─ … 5 steps');
  });

  it('should mark the initial step of a task that has never run', () => {
    const lines = render(undefined, { status: 'pending' });

    expect(lines).toContain('├─ plan  ◀ starts here');
    expect(lines.filter((line) => line.includes('◀'))).toHaveLength(1);
  });

  it('should mark a completed task as stopped there rather than current', () => {
    expect(render([{ workflow: 'full', step: 'plan' }], { status: 'completed' }))
      .toContain('├─ plan  ◀ last');
  });

  it('should expand the branch a pointer resting on the call step itself entered', () => {
    const lines = render([{ workflow: 'full', step: 'implement' }]);

    // The branch opens and its first step carries the marker; the call nested
    // further in is off that step's path, so it stays collapsed.
    expect(lines).toContain('│  ├─ draft  ◀ current');
    expect(lines).toContain('│  │  └─ … 3 steps');
  });

  it('should note a call it cannot resolve instead of dropping the branch', () => {
    mockResolveWorkflowCallTarget.mockImplementation((
      _parent: WorkflowConfig,
      step: { call: string },
    ) => (step.call === 'release/publish' ? null : resolveCall(_parent, step)));

    const lines = [...renderTaskTree({
      taskName: 'refactor-auth',
      workflowIdentifier: 'pipeline/full',
      status: 'running',
      rootWorkflow: root,
      context,
      pointer: [{ workflow: 'full', step: 'plan' }],
    }).tree];

    expect(lines.at(-1)).toContain('… unavailable:');
    expect(lines.at(-1)).toContain('unknown workflow "release/publish"');
  });

  it('should print the current step as a value rewind --step accepts', () => {
    mockResolveWorkflowCallTarget.mockImplementation(resolveCall);
    const view = renderTaskTree({
      taskName: 'refactor-auth',
      workflowIdentifier: 'pipeline/full',
      status: 'running',
      rootWorkflow: root,
      context,
      pointer: NESTED_POINTER,
    });

    expect(view.currentStepSelector).toBe('full/implement > code-change/verify > gates/test');
    expect(formatTaskTreeView(view)).toContain(
      '--step "full/implement > code-change/verify > gates/test"',
    );
  });
});
