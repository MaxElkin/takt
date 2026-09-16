/**
 * Fork: `takt task tree` - where a task stands inside its workflow.
 *
 * The tree is upstream's restart tree, the same one `takt task rewind` selects
 * from and the interactive picker walks, so every step printed here is a step
 * those accept. What the fork adds is the view: the root workflow in full, the
 * current step's own branch expanded down to it, and every other
 * `workflow_call` collapsed to a count. See stepTreeView.ts for the rendering.
 */

import type {
  WorkflowConfig,
  WorkflowRestartPointEntry,
} from '../../../core/models/index.js';
import type { TaskPointerEntry } from './taskPointer.js';
import {
  buildTaskRetryRestartTree,
  type TaskRetryRestartTreeLeaf,
  type TaskRetryRestartTreeNode,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';
import { formatRestartPointPath } from '../restart/stepSelector.js';
import { collectLeaves, renderStepTree } from './stepTreeView.js';

export interface TaskTreeView {
  /** Header lines above the tree: name, workflow, status. */
  readonly header: readonly string[];
  /** The tree itself, one line per node. */
  readonly tree: readonly string[];
  /** The `--step` value for the current step, when one was located. */
  readonly currentStepSelector?: string;
}

export interface RenderTaskTreeInput {
  readonly taskName: string;
  readonly workflowIdentifier: string;
  readonly status: string;
  readonly rootWorkflow: WorkflowConfig;
  readonly context: TaskRetryStartPathContext;
  /** The task's current pointer, absent when it has never run. */
  readonly pointer?: readonly TaskPointerEntry[];
  /** Expand every workflow_call instead of only the current step's branch. */
  readonly full?: boolean;
}

/** Shared with `takt task list`, so one glyph means "current" everywhere. */
export const MARKER_CURRENT = '◀ current';
const MARKER_START = '◀ starts here';
const MARKER_LAST = '◀ last';

/**
 * A pointer frame and a tree entry name the same position when their workflow
 * and step agree. The caller step names already sit in the stack, so a child
 * workflow called twice is told apart by them without comparing occurrences.
 */
function stackMatchesPointer(
  stack: readonly WorkflowRestartPointEntry[],
  pointer: readonly TaskPointerEntry[],
): boolean {
  return stack.length === pointer.length
    && stack.every((entry, index) =>
      entry.workflow === pointer[index]!.workflow && entry.step === pointer[index]!.step);
}

/**
 * The tree leaf a pointer stands on. Exported so `takt task instruction`
 * resolves the same step this tree marks as current.
 */
export function findCurrentLeaf(
  nodes: readonly TaskRetryRestartTreeNode[],
  pointer: readonly TaskPointerEntry[] | undefined,
): TaskRetryRestartTreeLeaf | undefined {
  if (pointer === undefined || pointer.length === 0) {
    return undefined;
  }
  const leaves = collectLeaves(nodes);
  return leaves.find((leaf) => stackMatchesPointer(leaf.restartPoint.stack, pointer))
    // A pointer resting on a workflow_call step itself, or on a frame the tree
    // no longer carries, still identifies the branch it entered.
    ?? leaves.find((leaf) => stackMatchesPointer(
      leaf.restartPoint.stack.slice(0, pointer.length),
      pointer,
    ));
}

/**
 * Which marker the current step carries. A task that has never run has no
 * pointer, so the workflow's initial step is where it *will* begin; a finished
 * one is where it stopped.
 */
function resolveCurrentMarker(
  pointer: readonly TaskPointerEntry[] | undefined,
  status: string,
): string {
  if (pointer === undefined || pointer.length === 0) {
    return MARKER_START;
  }
  return status.startsWith('completed') ? MARKER_LAST : MARKER_CURRENT;
}

/**
 * Locate the step a task without a pointer would begin at, so a never-run task
 * still shows where it stands rather than an unannotated tree.
 */
export function findInitialLeaf(
  nodes: readonly TaskRetryRestartTreeNode[],
  rootWorkflow: WorkflowConfig,
): TaskRetryRestartTreeLeaf | undefined {
  return collectLeaves(nodes).find((leaf) => {
    const first = leaf.restartPoint.stack[0];
    return first !== undefined
      && first.step === rootWorkflow.initialStep
      && leaf.restartPoint.stack.length === 1;
  });
}

export function renderTaskTree(input: RenderTaskTreeInput): TaskTreeView {
  const nodes = buildTaskRetryRestartTree(input.rootWorkflow, input.context);
  const currentLeaf = findCurrentLeaf(nodes, input.pointer)
    ?? (input.pointer === undefined || input.pointer.length === 0
      ? findInitialLeaf(nodes, input.rootWorkflow)
      : undefined);

  const header = [
    `Task:     ${input.taskName}`,
    `Workflow: ${input.workflowIdentifier}`,
    `Status:   ${input.status}`,
  ];
  const tree = [
    input.workflowIdentifier,
    ...renderStepTree(nodes, {
      ...(currentLeaf === undefined ? {} : { markedLeaf: currentLeaf }),
      marker: resolveCurrentMarker(input.pointer, input.status),
      ...(input.full === true ? { full: true } : {}),
    }),
  ];

  return {
    header,
    tree,
    ...(currentLeaf === undefined
      ? {}
      : { currentStepSelector: formatRestartPointPath(currentLeaf.restartPoint) }),
  };
}

/** The view as printed: header, blank line, tree, and the rewind hint. */
export function formatTaskTreeView(view: TaskTreeView): string {
  const lines = [...view.header, '', ...view.tree];
  if (view.currentStepSelector !== undefined) {
    lines.push('', `--step "${view.currentStepSelector}"`);
  }
  return lines.join('\n');
}
