/**
 * Fork: the Phase 1 prompt for one step, outside a run.
 *
 * `takt task instruction` exists so a step can be worked by an agent that is
 * not being orchestrated by TAKT. The text it prints is therefore built by
 * `InstructionBuilder` - the same builder the engine dispatches with, and the
 * one `takt prompt` previews with - rather than by a second renderer that
 * would drift from it. What upstream's preview does for every step of one
 * workflow with a placeholder task, this does for exactly the step a task
 * stands on, with that task's own request.
 *
 * Three things cannot be reconstructed outside a run and are absent by
 * construction: the previous step's response, accumulated user inputs, and a
 * retry note. The iteration counter reads 1 for the same reason.
 */

import type {
  Language,
  WorkflowConfig,
  WorkflowRestartPointEntry,
  WorkflowStep,
  WorkflowWideRule,
} from '../../../core/models/index.js';
import { buildCompanionInstructionContext } from '../../../core/workflow/companion/instruction-context.js';
import { mergeWorkflowWideRules } from '../../../core/workflow/engine/workflow-wide-rule-merge.js';
import { InstructionBuilder } from '../../../core/workflow/instruction/InstructionBuilder.js';
import type { InstructionContext } from '../../../core/workflow/instruction/instruction-context.js';
import {
  collectTaskReviewScope,
  resolveReviewScopeBaseRange,
  type TaskReviewScope,
} from '../../../core/workflow/review-scope.js';
import { isWorkflowCallStep } from '../../../core/workflow/step-kind.js';
import { resolveAuxiliaryRuntimeEnvironment } from '../../../infra/config/runtime-provider/provider-environment.js';
import { resolveWorkflowCallTarget } from '../../../infra/config/index.js';
import type { TaskRetryStartPathContext } from '../taskRetryStartPath.js';

export interface StepOwner {
  /** The workflow the step is authored in - the root, or a called child. */
  readonly workflow: WorkflowConfig;
  /** Workflow-wide rules the step sees, parents' included. */
  readonly rules: readonly WorkflowWideRule[];
}

/**
 * Walk a restart stack down to the workflow that authors its last frame,
 * accumulating the workflow-wide rules each level contributes - the engine
 * inherits a parent's rules into every called child, so a nested step sees
 * more than its own workflow declares.
 */
export function resolveStepOwner(
  rootWorkflow: WorkflowConfig,
  stack: readonly WorkflowRestartPointEntry[],
  context: TaskRetryStartPathContext,
): StepOwner {
  let workflow = rootWorkflow;
  let rules: readonly WorkflowWideRule[] = [];
  for (const entry of stack.slice(0, -1)) {
    const callStep = workflow.steps.find((step) => step.name === entry.step);
    if (callStep === undefined || !isWorkflowCallStep(callStep)) {
      throw new Error(`Step "${entry.step}" in workflow "${workflow.name}" is not a workflow call`);
    }
    const child = resolveWorkflowCallTarget(
      workflow,
      callStep,
      context.projectCwd,
      context.lookupCwd,
    );
    if (child === null) {
      throw new Error(`workflow_call step "${callStep.name}" references unknown workflow "${callStep.call}"`);
    }
    rules = mergeWorkflowWideRules(rules, workflow.allStepsRules);
    workflow = child;
  }
  return { workflow, rules: mergeWorkflowWideRules(rules, workflow.allStepsRules) };
}

export interface BuildStepInstructionInput {
  readonly step: WorkflowStep;
  readonly owner: StepOwner;
  readonly context: TaskRetryStartPathContext;
  readonly language: Language;
  /** The task text the engine would have opened the prompt with. */
  readonly task: string;
  /** The run's report directory, absent when the task has never run. */
  readonly reportDir?: string;
  /** What `{task_artifacts_dir}` renders as, absent when none is configured. */
  readonly taskArtifactsDir?: string;
}

/**
 * The review scope is a diagnostic here, not the point of the command: a
 * missing or broken git repository must not cost the caller the prompt. The
 * engine's own resolution stays fail-fast; only this path degrades.
 */
function resolveScope(cwd: string): TaskReviewScope | undefined {
  try {
    return collectTaskReviewScope({ cwd, baseRange: resolveReviewScopeBaseRange(cwd) });
  } catch {
    return undefined;
  }
}

export function buildStepInstruction(input: BuildStepInstructionInput): string {
  const { step, owner, context } = input;
  const runtime = resolveAuxiliaryRuntimeEnvironment(context.lookupCwd, owner.workflow);
  const stepIndex = owner.workflow.steps.findIndex((candidate) => candidate.name === step.name);
  const instructionContext: InstructionContext = {
    task: input.task,
    iteration: 1,
    maxSteps: owner.workflow.maxSteps,
    stepIteration: 1,
    cwd: context.lookupCwd,
    projectCwd: context.projectCwd,
    userInputs: [],
    workflowSteps: owner.workflow.steps,
    currentStepIndex: stepIndex,
    workflowName: owner.workflow.name,
    ...(owner.workflow.description === undefined
      ? {}
      : { workflowDescription: owner.workflow.description }),
    ...(input.reportDir === undefined ? {} : { reportDir: input.reportDir }),
    ...(input.taskArtifactsDir === undefined
      ? {}
      : { taskArtifactsDir: input.taskArtifactsDir }),
    // No run exists, so a {report:X} reference has nothing to resolve against;
    // containment validation still applies.
    validateReportReferences: false,
    language: input.language,
    reviewScope: resolveScope(context.lookupCwd),
    workflowRules: step.engineSynthesized === true ? undefined : owner.rules,
    companion: buildCompanionInstructionContext({
      companionEnabled: runtime.companionEnabled,
      companionReviewMode: runtime.companionReviewMode,
      cwd: context.lookupCwd,
      step,
      getRunSlug: () => 'instruction',
      getRunPathNamespace: () => [],
    }),
  };

  return new InstructionBuilder(step, instructionContext).build();
}

/** The heading the Phase 1 template gives both of its context sections. */
const EXECUTION_CONTEXT_HEADING = '## Execution Context';

/**
 * The part of the built prompt that says where the task stands: workflow,
 * structure, step, iteration, report info.
 *
 * `--complete` prints this instead of the whole prompt, so the section is cut
 * out of what `InstructionBuilder` produced rather than composed a second time.
 * The Phase 1 template heads two sections this way - the first carries only the
 * working directory - so the one naming the step is the one taken, which also
 * keeps a step instruction that happens to use the same heading from matching.
 */
export function extractExecutionContext(instruction: string, stepName: string): string {
  const lines = instruction.split('\n');

  for (const [start, line] of lines.entries()) {
    if (line.trim() !== EXECUTION_CONTEXT_HEADING) continue;
    const after = lines.findIndex((candidate, index) => index > start && candidate.startsWith('## '));
    const block = lines.slice(start, after === -1 ? lines.length : after).join('\n').trimEnd();
    if (block.includes(`- Step: ${stepName}`)) {
      return block;
    }
  }

  throw new Error(`The built prompt has no execution context naming step "${stepName}".`);
}
