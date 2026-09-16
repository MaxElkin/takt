/**
 * Fork: rendering a restart tree as text, shared by the task and workflow views.
 *
 * The tree itself is upstream's (`buildTaskRetryRestartTree`), which is why
 * this lives beside it under `features/tasks` even though the workflow view has
 * no task: both views are views of that one structure, so a step shown by
 * either is a step `takt task rewind` and the interactive picker accept.
 *
 * What differs between the views is only which branches open. A view supplies
 * the id of the branch to follow, or none, and every other `workflow_call`
 * collapses to a count of what it hides.
 */

import type {
  TaskRetryRestartTreeHeading,
  TaskRetryRestartTreeLeaf,
  TaskRetryRestartTreeNode,
} from '../taskRetryStartPath.js';

export interface StepTreeRenderOptions {
  /**
   * The leaf whose ancestors expand. Every other `workflow_call` collapses.
   * Absent collapses them all, which is the workflow view's default.
   */
  readonly markedLeaf?: TaskRetryRestartTreeLeaf;
  /** Trailing annotation for `markedLeaf`, such as `◀ current`. */
  readonly marker?: string;
  /** Expand every `workflow_call` regardless of the marked branch. */
  readonly full?: boolean;
}

export function isHeading(
  node: TaskRetryRestartTreeNode,
): node is TaskRetryRestartTreeHeading {
  return node.kind === 'heading';
}

/** Every selectable step under a node, however deep - what `…` stands for. */
export function countLeaves(nodes: readonly TaskRetryRestartTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (isHeading(node) ? countLeaves(node.children) : 1),
    0,
  );
}

export function collectLeaves(
  nodes: readonly TaskRetryRestartTreeNode[],
): TaskRetryRestartTreeLeaf[] {
  return nodes.flatMap((node) => (isHeading(node) ? collectLeaves(node.children) : [node]));
}

/** Node ids are dot-separated position paths, so ancestry is a prefix test. */
function isAncestorOf(heading: TaskRetryRestartTreeHeading, leafId: string): boolean {
  return leafId.startsWith(`${heading.id}.`);
}

function headingLabel(heading: TaskRetryRestartTreeHeading): string {
  const call = heading.step.kind === 'workflow_call' ? heading.step.call : undefined;
  return call === undefined ? heading.step.name : `${heading.step.name} → ${call}`;
}

function collapsedLine(heading: TaskRetryRestartTreeHeading): string {
  if (heading.note !== undefined) {
    return `… unavailable: ${heading.note}`;
  }
  const count = countLeaves(heading.children);
  return `… ${count} ${count === 1 ? 'step' : 'steps'}`;
}

export function renderStepTree(
  nodes: readonly TaskRetryRestartTreeNode[],
  options: StepTreeRenderOptions,
  prefix = '',
): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const branch = isLast ? '└─ ' : '├─ ';
    const childPrefix = `${prefix}${isLast ? '   ' : '│  '}`;
    if (!isHeading(node)) {
      const marked = node === options.markedLeaf && options.marker !== undefined;
      lines.push(`${prefix}${branch}${node.step.name}${marked ? `  ${options.marker}` : ''}`);
      return;
    }
    lines.push(`${prefix}${branch}${headingLabel(node)}`);
    const expand = options.full === true
      || (options.markedLeaf !== undefined && isAncestorOf(node, options.markedLeaf.id));
    if (expand && node.children.length > 0) {
      lines.push(...renderStepTree(node.children, options, childPrefix));
      return;
    }
    lines.push(`${childPrefix}└─ ${collapsedLine(node)}`);
  });
  return lines;
}
