import type {
  WorkflowConfig,
  WorkflowRestartPoint,
  WorkflowRestartPointEntry,
} from '../../../core/models/index.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { isWorkflowRestartTarget } from '../../../core/workflow/workflow-restart-target.js';
import { getWorkflowReference } from '../../../core/workflow/workflow-reference.js';
import {
  assertCallableChildBoundary,
  createRestartEntry,
  resolveCallableChild,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';

/** Build a fresh restart path that follows each workflow's declared initial step. */
export function buildInitialWorkflowRestartPoint(
  rootWorkflow: WorkflowConfig,
  context: TaskRetryStartPathContext,
): WorkflowRestartPoint {
  const build = (
    workflow: WorkflowConfig,
    stack: readonly WorkflowRestartPointEntry[],
    ancestors: readonly string[],
  ): WorkflowRestartPoint => {
    const step = workflow.steps.find((candidate) => candidate.name === workflow.initialStep);
    if (step === undefined || !isWorkflowRestartTarget(step)) {
      throw new Error(
        `Workflow "${workflow.name}" initial step "${workflow.initialStep}" is not eligible for restart`,
      );
    }
    const entry = createRestartEntry(workflow, step);
    const nextStack = [...stack, entry];
    if (!isWorkflowCallStep(step)) {
      return { stack: nextStack };
    }

    const child = resolveCallableChild(workflow, step, context);
    assertCallableChildBoundary(child, ancestors);
    return build(child, nextStack, [...ancestors, getWorkflowReference(child)]);
  };

  return build(rootWorkflow, [], [getWorkflowReference(rootWorkflow)]);
}
