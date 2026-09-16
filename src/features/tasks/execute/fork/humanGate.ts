/**
 * Fork: decide whether a workflow run can ask a human, for workflowExecutionBootstrap.
 */

import { getAllParallelSubSteps, type WorkflowConfig, type WorkflowStep } from '../../../../core/models/index.js';
import type { WorkflowCallResolver } from '../../../../core/workflow/types.js';
import { collectWorkflowCallSteps } from '../../../../core/workflow/workflow-step-traversal.js';
import { getWorkflowReference } from '../../../../core/workflow/workflow-reference.js';
import { canReadPipedStdin } from '../../../../shared/prompt/index.js';

interface HumanGateDiscoveryOptions {
  workflowCallResolver?: WorkflowCallResolver;
  projectCwd: string;
  lookupCwd: string;
}

/**
 * Whether this workflow declares a checkpoint that only a human can clear:
 * a step marked `requires_user_input`, or a rule gated by `requires_approval`.
 *
 * Rule-level `requires_user_input` deliberately does NOT count. Builtin
 * workflows pair it with `interactive_only` to mean "ask if someone happens to
 * be watching", and treating that as a requirement would make every builtin
 * stop and wait during an unattended `takt run`.
 */
function stepDeclaresHumanGate(step: WorkflowStep): boolean {
  if (
    step.requiresUserInput === true
    || step.rules?.some((rule) => (
      rule.requiresApproval === true && rule.interactiveOnly !== true
    )) === true
  ) {
    return true;
  }
  return step.parallel !== undefined
    && getAllParallelSubSteps(step.parallel).some(stepDeclaresHumanGate);
}

export function workflowDeclaresHumanGate(
  workflowConfig: WorkflowConfig,
  options?: HumanGateDiscoveryOptions,
): boolean {
  const activeReferences = new Set<string>();
  const visit = (workflow: WorkflowConfig): boolean => {
    const reference = getWorkflowReference(workflow);
    if (activeReferences.has(reference)) return false;
    activeReferences.add(reference);
    try {
      if (workflow.steps.some(stepDeclaresHumanGate)) return true;
      if (options?.workflowCallResolver === undefined) return false;

      return collectWorkflowCallSteps(workflow.steps).some((step) => {
        const child = options.workflowCallResolver?.({
          parentWorkflow: workflow,
          step,
          projectCwd: options.projectCwd,
          lookupCwd: options.lookupCwd,
        });
        return child !== null && child !== undefined && visit(child);
      });
    } finally {
      activeReferences.delete(reference);
    }
  };

  return visit(workflowConfig);
}

/**
 * A gate can only be cleared by someone who can actually be prompted, so a
 * headless run must fail its pre-flight rather than block on stdin.
 */
function canPromptForUserInput(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Which prompts this run may show: workflow user input, and provider permission requests. */
export function resolveInteractiveChannels(
  workflowConfig: WorkflowConfig,
  options: HumanGateDiscoveryOptions & { interactiveUserInput?: boolean },
): { interactiveUserInput: boolean; interactivePermissionPrompt: boolean } {
  // A caller that has an opinion wins. Otherwise the channel follows the
  // workflow: queued tasks stay non-interactive as documented unless this one
  // declares a human gate, and even then only when there is a terminal to ask.
  const interactiveUserInput = options.interactiveUserInput
    ?? (workflowDeclaresHumanGate(workflowConfig, options) && canPromptForUserInput());
  // Any step can hit a permission request, so unlike a human gate this is not
  // something a workflow declares. A pipe counts as well as a terminal: the
  // prompt is plain numbered text so a process driving `takt` can answer it.
  // With neither, the provider keeps deciding alone, which is the correct
  // headless behaviour.
  const interactivePermissionPrompt = canPromptForUserInput() || canReadPipedStdin();
  return { interactiveUserInput, interactivePermissionPrompt };
}
