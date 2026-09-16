/**
 * Fork: `takt workflow tree` - a workflow's own steps, without a task.
 *
 * Same structure as `takt task tree`, minus the pointer: there is no run, so
 * nothing is current and no branch is on a path. Every `workflow_call`
 * therefore collapses, and `--full` is the only way to open them.
 *
 * It lives under `features/tasks/fork` rather than with the other workflow
 * authoring commands because the tree it renders is upstream's restart tree
 * (`../taskRetryStartPath.ts`), and features in this codebase import only
 * core, infra and shared - never each other. The command is still registered
 * on the upstream `workflow` group.
 */

import type { WorkflowConfig } from '../../../core/models/index.js';
import {
  buildTaskRetryRestartTree,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';
import { countLeaves, renderStepTree } from './stepTreeView.js';

export interface WorkflowTreeView {
  readonly header: readonly string[];
  readonly tree: readonly string[];
}

export interface RenderWorkflowTreeInput {
  readonly workflowIdentifier: string;
  readonly rootWorkflow: WorkflowConfig;
  readonly context: TaskRetryStartPathContext;
  /** Expand every workflow_call instead of collapsing them all. */
  readonly full?: boolean;
}

/** The step a run of this workflow begins at, marked so the entry is visible. */
const MARKER_INITIAL = '◀ initial';

export function renderWorkflowTree(input: RenderWorkflowTreeInput): WorkflowTreeView {
  const nodes = buildTaskRetryRestartTree(input.rootWorkflow, input.context);
  const total = countLeaves(nodes);
  const initialLeaf = nodes.find((node) =>
    node.kind === 'leaf' && node.step.name === input.rootWorkflow.initialStep);

  const header = [
    `Workflow:    ${input.workflowIdentifier}`,
    ...(input.rootWorkflow.description === undefined
      ? []
      : [`Description: ${input.rootWorkflow.description}`]),
    `Steps:       ${total} selectable`,
  ];
  const tree = [
    input.workflowIdentifier,
    ...renderStepTree(nodes, {
      // No pointer exists, so nothing expands by itself: the marked leaf is
      // only an annotation, and a root leaf never opens a branch.
      ...(initialLeaf?.kind === 'leaf' ? { markedLeaf: initialLeaf } : {}),
      marker: MARKER_INITIAL,
      ...(input.full === true ? { full: true } : {}),
    }),
  ];

  return { header, tree };
}

export function formatWorkflowTreeView(view: WorkflowTreeView): string {
  return [...view.header, '', ...view.tree].join('\n');
}
