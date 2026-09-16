import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowCallStep, WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { validateTaskRetryRestartPoint } from '../features/tasks/taskRetryStartPath.js';
import { buildInitialWorkflowRestartPoint } from '../features/tasks/restart/initialRestartPoint.js';
import { attachWorkflowOpaqueRef } from '../infra/config/loaders/workflowSourceMetadata.js';

const mockResolveWorkflowCallTarget = vi.hoisted(() => vi.fn());

vi.mock('../infra/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveWorkflowCallTarget: (...args: unknown[]) => mockResolveWorkflowCallTarget(...args),
}));

const pathContext = {
  projectCwd: '/project',
  lookupCwd: '/project/worktree',
};

function agentStep(name: string): WorkflowStep {
  return {
    name,
    persona: `${name}-persona`,
    personaDisplayName: name,
    instruction: `${name} instruction`,
  };
}

function callStep(name: string, call: string): WorkflowCallStep {
  return {
    name,
    kind: 'workflow_call',
    call,
    personaDisplayName: name,
    instruction: `${name} instruction`,
  };
}

function makeWorkflow(options: {
  name: string;
  ref: string;
  steps: WorkflowStep[];
  initialStep?: string;
  callable?: boolean;
}): WorkflowConfig {
  return attachWorkflowOpaqueRef({
    name: options.name,
    initialStep: options.initialStep ?? options.steps[0]!.name,
    maxSteps: 20,
    steps: options.steps,
    ...(options.callable ? { subworkflow: { callable: true } } : {}),
  }, options.ref);
}

beforeEach(() => {
  mockResolveWorkflowCallTarget.mockReset();
});

describe('buildInitialWorkflowRestartPoint', () => {
  it('should restart from the declared initial step even when it is not first in the file', () => {
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'implement',
      steps: [agentStep('plan'), agentStep('implement')],
    });

    const restartPoint = buildInitialWorkflowRestartPoint(root, pathContext);

    expect(restartPoint.stack).toEqual([
      expect.objectContaining({ step: 'implement', workflow_ref: 'project:root' }),
    ]);
  });

  it('should follow declared initial workflow calls to the child initial step', () => {
    const child = makeWorkflow({
      name: 'child',
      ref: 'project:child',
      callable: true,
      initialStep: 'child-start',
      steps: [agentStep('unused-first'), agentStep('child-start')],
    });
    const root = makeWorkflow({
      name: 'default',
      ref: 'project:root',
      initialStep: 'call-child',
      steps: [agentStep('unused-root'), callStep('call-child', 'child')],
    });
    mockResolveWorkflowCallTarget.mockReturnValue(child);

    const restartPoint = buildInitialWorkflowRestartPoint(root, pathContext);

    expect(restartPoint.stack.map((entry) => entry.step)).toEqual(['call-child', 'child-start']);
    expect(() => validateTaskRetryRestartPoint(root, restartPoint, pathContext)).not.toThrow();
  });
});
