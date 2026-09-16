import { describe, expect, it, vi } from 'vitest';
import type { WorkflowCallStep, WorkflowConfig, WorkflowStep } from '../core/models/index.js';
import { workflowDeclaresHumanGate } from '../features/tasks/execute/fork/humanGate.js';
import { makeRule } from './test-helpers.js';

function workflow(name: string, steps: WorkflowStep[]): WorkflowConfig {
  return {
    name,
    description: `${name} workflow`,
    maxSteps: 5,
    initialStep: steps[0]?.name ?? 'missing',
    steps,
  };
}

function agentStep(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name,
    personaDisplayName: name,
    instruction: `Run ${name}`,
    ...overrides,
  } as WorkflowStep;
}

function callStep(name: string, call: string): WorkflowCallStep {
  return {
    kind: 'workflow_call',
    name,
    call,
    personaDisplayName: name,
    instruction: `Call ${call}`,
  };
}

describe('workflowDeclaresHumanGate', () => {
  it('finds a gate inside a parallel step tree', () => {
    const root = workflow('root', [agentStep('parallel', {
      parallel: [agentStep('ask', { requiresUserInput: true })],
    })]);

    expect(workflowDeclaresHumanGate(root)).toBe(true);
  });

  it('finds a required gate in a nested workflow call', () => {
    const child = workflow('child', [agentStep('ask', { requiresUserInput: true })]);
    const root = workflow('root', [callStep('call-child', 'child')]);
    const resolver = vi.fn(({ step }: { step: WorkflowCallStep }) => (
      step.call === 'child' ? child : null
    ));

    expect(workflowDeclaresHumanGate(root, {
      workflowCallResolver: resolver,
      projectCwd: '/project',
      lookupCwd: '/lookup',
    })).toBe(true);
  });

  it('ignores interactive-only approval rules during gate discovery', () => {
    const root = workflow('root', [agentStep('review', {
      rules: [makeRule('approved', 'COMPLETE', {
        requiresApproval: true,
        interactiveOnly: true,
      })],
    })]);

    expect(workflowDeclaresHumanGate(root)).toBe(false);
  });

  it('terminates safely when workflow calls form a cycle', () => {
    const root = workflow('root', [callStep('call-child', 'child')]);
    const child = workflow('child', [callStep('call-root', 'root')]);
    const resolver = ({ step }: { step: WorkflowCallStep }): WorkflowConfig | null => (
      step.call === 'root' ? root : step.call === 'child' ? child : null
    );

    expect(workflowDeclaresHumanGate(root, {
      workflowCallResolver: resolver,
      projectCwd: '/project',
      lookupCwd: '/lookup',
    })).toBe(false);
  });
});
