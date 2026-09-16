/**
 * Fork: `takt task instruction` command handler.
 *
 * Prints the Phase 1 prompt for the step a task stands on - the step
 * `takt task tree` marks as current - and nothing else, so the output can be
 * piped straight to an agent working outside TAKT's orchestration. Everything
 * that is not the prompt goes to stderr.
 *
 * `--complete` prints a different thing, for an agent that has already done the
 * work: where the task stands and what the step owes, and nothing else. With a
 * result passed to it, nothing is printed but the step the task moved to. See
 * stepCompletion.ts for what a result is read as.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Language, WorkflowRestartPoint } from '../../../core/models/index.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { resolveTaskArtifactsDir } from '../../../core/workflow/instruction/fork/taskArtifactsDir.js';
import { loadProjectConfig, resolveWorkflowConfigValue } from '../../../infra/config/index.js';
import { TaskRunner, buildTaskInstruction } from '../../../infra/task/index.js';
import type { TaskListItem } from '../../../infra/task/index.js';
import { error, success } from '../../../shared/ui/index.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import { sanitizeTerminalText } from '../../../shared/utils/index.js';
import {
  buildTaskRetryRestartTree,
  createRestartEntry,
  validateTaskRetryRestartPoint,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';
import { formatRestartPointPath } from '../restart/stepSelector.js';
import { buildBlankOrderTaskInstruction, isBlankTaskOrder } from './taskPrompt.js';
import { locateTask, type LocatedTask } from './taskPointer.js';
import { findCurrentLeaf, findInitialLeaf } from './taskTree.js';
import {
  buildStepInstruction,
  extractExecutionContext,
  resolveStepOwner,
  type StepOwner,
} from './stepInstruction.js';
import { renderCompletionContract, resolveSubmittedCompletion } from './stepCompletion.js';

/** Statuses whose pointer may be moved: a running task belongs to its engine. */
const MOVABLE_STATUSES = ['pending', 'failed', 'completed'] as const;

export interface TaskInstructionOptions {
  /** Append the completion contract to the prompt. */
  readonly complete?: boolean;
  /** A finished step's result, to be read and acted on instead of printed. */
  readonly result?: string;
}

/**
 * The task text the engine would open the prompt with. Inside a run the spec
 * is staged into the run's context directory and the pointer names it there;
 * outside one, the task's own directory is where the spec actually is, so the
 * pointer names that instead of a path that does not exist yet.
 */
function resolveTaskText(projectDir: string, task: TaskListItem): string {
  if (task.taskDir === undefined) {
    return task.content;
  }
  const orderRel = path.posix.join(task.taskDir.replace(/\\/g, '/'), 'order.md');
  const orderContent = fs.readFileSync(path.join(projectDir, orderRel), 'utf-8');
  return isBlankTaskOrder(orderContent)
    ? buildBlankOrderTaskInstruction()
    : buildTaskInstruction(task.taskDir, orderRel);
}

/**
 * Move the task's pointer to a step of the same workflow, without running it.
 * `requeueTask` is what upstream's own auto-requeue writes a restart point
 * with, so the record this leaves behind is one `takt task resume` already
 * knows how to pick up.
 */
function advanceTask(
  projectDir: string,
  located: LocatedTask,
  owner: StepOwner,
  currentStack: WorkflowRestartPoint['stack'],
  nextStepName: string,
  context: TaskRetryStartPathContext,
  pauses: boolean,
): void {
  const nextStep = owner.workflow.steps.find((step) => step.name === nextStepName);
  if (nextStep === undefined) {
    error(`Step "${sanitizeTerminalText(nextStepName)}" is not in workflow "${owner.workflow.name}".`);
    process.exitCode = 1;
    return;
  }
  const restartPoint: WorkflowRestartPoint = {
    stack: [...currentStack.slice(0, -1), createRestartEntry(owner.workflow, nextStep)],
  };
  try {
    validateTaskRetryRestartPoint(located.workflow, restartPoint, context);
  } catch (err) {
    error(`Cannot move to "${sanitizeTerminalText(nextStepName)}": ${sanitizeTerminalText(getErrorMessage(err))}`);
    process.exitCode = 1;
    return;
  }

  new TaskRunner(projectDir).requeueTask(located.task.name, MOVABLE_STATUSES, {
    restartPoint,
    ...(located.runSlug === undefined ? {} : { sourceRunSlug: located.runSlug }),
  });
  success(`Moved to ${formatRestartPointPath(restartPoint)}`);
  if (pauses) {
    console.error('In a run this transition would stop for the human first.');
  }
}

export function printTaskInstruction(
  projectDir: string,
  name: string,
  options: TaskInstructionOptions = {},
): void {
  const located = locateTask(projectDir, name);
  if (located === undefined) {
    return;
  }

  const context: TaskRetryStartPathContext = {
    projectCwd: projectDir,
    lookupCwd: located.lookupCwd,
  };
  const nodes = buildTaskRetryRestartTree(located.workflow, context);
  const leaf = findCurrentLeaf(nodes, located.pointer)
    ?? (located.pointer === undefined || located.pointer.length === 0
      ? findInitialLeaf(nodes, located.workflow)
      : undefined);
  if (leaf === undefined) {
    error(`Task "${sanitizeTerminalText(name)}" does not stand on a step of its workflow.`);
    process.exitCode = 1;
    return;
  }

  let owner: StepOwner;
  try {
    owner = resolveStepOwner(located.workflow, leaf.restartPoint.stack, context);
  } catch (err) {
    error(`Could not resolve the step's workflow: ${sanitizeTerminalText(getErrorMessage(err))}`);
    process.exitCode = 1;
    return;
  }

  if (options.result !== undefined) {
    if (!MOVABLE_STATUSES.some((status) => status === located.task.kind)) {
      error(`Task "${sanitizeTerminalText(name)}" is ${located.task.kind}; its pointer belongs to the run that owns it.`);
      process.exitCode = 1;
      return;
    }
    const resolution = resolveSubmittedCompletion(leaf.step, options.result);
    if (resolution.kind === 'refused') {
      error(sanitizeTerminalText(resolution.reason));
      process.exitCode = 1;
      return;
    }
    if (resolution.kind === 'terminal') {
      success(sanitizeTerminalText(resolution.reason));
      return;
    }
    advanceTask(
      projectDir,
      located,
      owner,
      leaf.restartPoint.stack,
      resolution.nextStep,
      context,
      resolution.pauses === true,
    );
    return;
  }

  // A nested step's reports live under a run-path namespace the engine builds
  // from live iteration counters, which no amount of reading the record can
  // reconstruct. The run's reports root is the honest answer, said out loud.
  const reportDir = located.runSlug === undefined
    ? undefined
    : buildRunPaths(located.lookupCwd, located.runSlug).reportsRel;
  // Said on stderr: stdout carries the prompt and nothing else, so the command
  // stays safe to pipe.
  if (reportDir !== undefined && leaf.restartPoint.stack.length > 1) {
    console.error('Report paths name the run\'s reports root, not the subworkflow\'s namespace.');
  }

  // Resolved the way the execution boundary resolves it, so a step writing to
  // {task_artifacts_dir} names the same directory it would name in a run.
  const artifactsDir = resolveTaskArtifactsDir(
    loadProjectConfig(projectDir).tasksArtifactsDir,
    located.task.name,
  );
  const language = resolveWorkflowConfigValue(projectDir, 'language') as Language;

  try {
    const instruction = buildStepInstruction({
      step: leaf.step,
      owner,
      context,
      language,
      task: resolveTaskText(projectDir, located.task),
      ...(reportDir === undefined ? {} : { reportDir }),
      ...(artifactsDir === undefined ? {} : { taskArtifactsDir: artifactsDir }),
    });
    // `--complete` is for a step already worked, not one about to be: what is
    // wanted then is where the task stands and what it owes, not the persona,
    // the policy and the work all over again.
    console.log(options.complete === true
      ? [
          extractExecutionContext(instruction, leaf.step.name),
          '',
          renderCompletionContract(leaf.step, language),
        ].join('\n')
      : instruction);
  } catch (err) {
    error(`Could not build the instruction: ${sanitizeTerminalText(getErrorMessage(err))}`);
    process.exitCode = 1;
  }
}
