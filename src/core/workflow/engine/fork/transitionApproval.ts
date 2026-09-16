/**
 * Fork: rule-level `requires_approval` and `user_prompt_field` for WorkflowRunLoop.
 *
 * WorkflowRunLoop keeps only the call sites; the gate itself lives here.
 */

import type { AgentResponse, WorkflowStep } from '../../../models/types.js';
import { isNormalAgentWorkflowStep } from '../../../models/types.js';
import type { UserInputRequest, WorkflowAbortKind } from '../../types.js';
import type { WorkflowRuleTransition } from '../transitions.js';

/** Structured-output field a step is assumed to address the human through. */
const DEFAULT_USER_PROMPT_FIELD = 'message';

/**
 * The part of a reply that is addressed to the human.
 *
 * A step that routes on structured output still has to say something readable:
 * without this the prompt shows the whole reply, JSON and all, and the human
 * has to find the question inside it.
 *
 * `structuredOutput` is only ever populated for a step that declared a schema,
 * so defaulting the field name costs a plain prose step nothing. A step whose
 * readable text lives under another name says so with `user_prompt_field`.
 */
export function humanFacingContent(step: WorkflowStep, response: AgentResponse): string {
  const field = (isNormalAgentWorkflowStep(step) ? step.userPromptField : undefined)
    ?? DEFAULT_USER_PROMPT_FIELD;
  const value = response.structuredOutput?.[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : response.content;
}

/**
 * Rule-level requires_approval: once the executor has chosen a transition, TAKT
 * asks whether it may be taken. The executor is not involved and does not know
 * the gate exists, so nothing interprets the answer on its way to the branch.
 * "y" lets the transition stand; anything else goes back to the step as user
 * input and the step runs again; empty cancels, as everywhere else.
 */
export type TransitionApproval =
  | { kind: 'approved' }
  | { kind: 'rejected'; userInput: string; feedback: string }
  | { kind: 'aborted'; abortKind: WorkflowAbortKind; reason: string };

function isApprovalReply(input: string): boolean {
  return /^(y|yes)$/i.test(input.trim());
}

function describeTransitionTarget(transition: WorkflowRuleTransition): string {
  if (transition.returnValue !== undefined) {
    return `finish the workflow with "${transition.returnValue}"`;
  }
  return transition.nextStep === undefined
    ? 'take this transition'
    : `go to "${transition.nextStep}"`;
}

export async function requestTransitionApproval(
  onUserInput: ((request: UserInputRequest) => Promise<string | null>) | undefined,
  step: WorkflowStep,
  response: AgentResponse,
  transition: WorkflowRuleTransition,
): Promise<TransitionApproval> {
  if (onUserInput === undefined) {
    return {
      kind: 'aborted',
      abortKind: 'user_input_required',
      reason: `Step "${step.name}" has an approval gate but no handler is configured`,
    };
  }
  const question = `Step "${step.name}" is done and wants to ${describeTransitionTarget(transition)}.`
    + ' Approve? Reply "y" to accept, anything else goes back to the step.';
  const userInput = await onUserInput({
    step,
    response,
    prompt: `${humanFacingContent(step, response)}\n\n---\n${question}`,
  });
  if (userInput === null) {
    return { kind: 'aborted', abortKind: 'user_input_cancelled', reason: 'User input cancelled' };
  }
  return isApprovalReply(userInput)
    ? { kind: 'approved' }
    : { kind: 'rejected', userInput, feedback: buildRejectionFeedback(step, transition, userInput) };
}

/**
 * What the executor is told when its transition is declined.
 *
 * Approval itself stays invisible to the executor - nothing should interpret a
 * "y" on its way to the branch. A rejection is the opposite: without knowing
 * which transition was refused, the executor reads the reply as ordinary
 * feedback about the work and re-picks the same route, which is exactly what a
 * bare user input produced before this existed.
 */
function buildRejectionFeedback(
  step: WorkflowStep,
  transition: WorkflowRuleTransition,
  userInput: string,
): string {
  const lines = [
    `You ended the step "${step.name}" and chose to ${describeTransitionTarget(transition)}.`,
    'The human declined that and replied:',
    '',
    userInput,
    '',
    'Their reply is about where this step goes next, not only about the work itself.',
    'Reconsider, and choose the transition that is actually true of the situation.',
  ];
  if (step.requiresUserInput === true) {
    lines.push('If none of them is true, ask them rather than asserting one that is not.');
  }
  return lines.join('\n');
}

/** A step carrying an active approval rule needs the same interactive runtime as one that asks. */
export function stepHasApprovalRule(step: WorkflowStep, interactive: boolean): boolean {
  return step.rules?.some((rule) => (
    rule.requiresApproval === true
    && (interactive || rule.interactiveOnly !== true)
  )) === true;
}
