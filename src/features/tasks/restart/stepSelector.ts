/**
 * Fork: resolve `takt task rewind --workflow/--step` against the restart tree.
 *
 * The tree itself is upstream's (`buildTaskRetryRestartTree`), the same one the
 * interactive picker walks, so a step is selectable here exactly when it is
 * selectable there. Only the non-interactive naming of a node lives in the fork.
 */

import type { WorkflowConfig, WorkflowRestartPoint, WorkflowRestartPointEntry } from '../../../core/models/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import {
  buildTaskRetryRestartTree,
  type TaskRetryRestartTreeLeaf,
  type TaskRetryRestartTreeNode,
  type TaskRetryStartPathContext,
} from '../taskRetryStartPath.js';

/** Separator between path segments, in both the parsed and the printed form. */
const PATH_SEPARATOR = ' > ';

interface SelectorSegment {
  /** Workflow name or ref the step must belong to, when the segment qualifies it. */
  workflow?: string;
  step: string;
}

function collectLeaves(nodes: readonly TaskRetryRestartTreeNode[]): TaskRetryRestartTreeLeaf[] {
  const leaves: TaskRetryRestartTreeLeaf[] = [];
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      leaves.push(node);
      continue;
    }
    leaves.push(...collectLeaves(node.children));
  }
  return leaves;
}

/** The printed form of a leaf, which is also an accepted `--step` value. */
export function formatRestartPointPath(restartPoint: WorkflowRestartPoint): string {
  return restartPoint.stack
    .map((entry) => `${entry.workflow}/${entry.step}`)
    .join(PATH_SEPARATOR);
}

/**
 * A restart entry carries the workflow's `name`, but a workflow is *addressed*
 * by its identifier, which is folder-qualified when the YAML lives in a
 * category subdirectory (`consult/consult`, `review/consult-review`). Accept
 * either, plus the identifier the root workflow was loaded by, so what works
 * for `takt task add --workflow` works here.
 */
function entryMatchesWorkflow(
  entry: WorkflowRestartPointEntry,
  workflow: string,
  aliases: readonly string[] = [],
): boolean {
  const candidates = [entry.workflow, entry.workflow_ref, ...aliases];
  return candidates.includes(workflow) || candidates.includes(lastPathSegment(workflow));
}

function lastPathSegment(value: string): string {
  const boundary = value.lastIndexOf('/');
  return boundary === -1 ? value : value.slice(boundary + 1);
}

/**
 * Split a selector into segments. A segment is `step` or `<workflow>/<step>`;
 * the workflow is everything before the last `/`, so an identifier that itself
 * contains a slash (`consult/consult`) still parses.
 */
function parseSelector(selector: string): SelectorSegment[] {
  return selector.split('>').map((raw) => {
    const segment = raw.trim();
    const boundary = segment.lastIndexOf('/');
    if (boundary === -1) {
      return { step: segment };
    }
    return { workflow: segment.slice(0, boundary), step: segment.slice(boundary + 1) };
  });
}

/**
 * A leaf matches when the segments are a suffix of its stack: `ask` names every
 * `ask` in the tree, and a longer path narrows it by naming its callers. That
 * is why the ambiguity error can print full paths - each one selects the leaf
 * it came from.
 */
function leafMatchesSegments(
  leaf: TaskRetryRestartTreeLeaf,
  segments: readonly SelectorSegment[],
  rootAliases: readonly string[],
): boolean {
  const { stack } = leaf.restartPoint;
  if (segments.length > stack.length) {
    return false;
  }
  const offset = stack.length - segments.length;
  return segments.every((segment, index) => {
    const position = offset + index;
    const entry = stack[position]!;
    if (entry.step !== segment.step) {
      return false;
    }
    return segment.workflow === undefined
      || entryMatchesWorkflow(entry, segment.workflow, position === 0 ? rootAliases : []);
  });
}

function quoted(value: string): string {
  return `"${sanitizeTerminalText(value)}"`;
}

/**
 * Resolve `--step` (optionally narrowed by `--workflow`) into a restart point.
 *
 * `--workflow` names a workflow **reachable from the task's own workflow** -
 * the root itself or any workflow a `workflow_call` leads to - not a
 * replacement for it. The task's workflow is what runs; the restart point
 * descends into the named one. `rootIdentifier` is how the task addresses its
 * own workflow (`consult/consult`), which is a name the root answers to.
 */
export function resolveTaskRewindRestartPoint(
  rootWorkflow: WorkflowConfig,
  stepSelector: string,
  context: TaskRetryStartPathContext,
  options: { workflow?: string; rootIdentifier?: string } = {},
): WorkflowRestartPoint {
  const selector = stepSelector.trim();
  if (selector.length === 0) {
    throw new Error('Task rewind requires a non-empty step.');
  }
  const segments = parseSelector(selector);
  if (segments.some((segment) => segment.step.length === 0)) {
    throw new Error(`Task rewind step ${quoted(selector)} is not a valid step path.`);
  }

  const leaves = collectLeaves(buildTaskRetryRestartTree(rootWorkflow, context));
  const rootAliases = options.rootIdentifier === undefined ? [] : [options.rootIdentifier];
  const workflow = options.workflow?.trim();
  const reachable = workflow === undefined || workflow.length === 0
    ? leaves
    : leaves.filter((leaf) => {
        const { stack } = leaf.restartPoint;
        return entryMatchesWorkflow(
          stack.at(-1)!,
          workflow,
          stack.length === 1 ? rootAliases : [],
        );
      });

  if (reachable.length === 0) {
    const names = [...new Set(leaves.map((leaf) => leaf.restartPoint.stack.at(-1)!.workflow))];
    throw new Error(
      `Workflow ${quoted(workflow!)} is not reachable from ${quoted(rootWorkflow.name)}; `
      + `reachable workflows: ${names.map(quoted).join(', ')}.`,
    );
  }

  const matches = reachable.filter((leaf) => leafMatchesSegments(leaf, segments, rootAliases));
  if (matches.length === 0) {
    throw new Error(
      `Workflow ${quoted(rootWorkflow.name)} has no authored restart step ${quoted(selector)}.`,
    );
  }
  if (matches.length > 1) {
    const choices = matches
      .map((leaf) => quoted(formatRestartPointPath(leaf.restartPoint)))
      .join(', ');
    throw new Error(
      `Task rewind step ${quoted(selector)} is ambiguous; choose one of: ${choices}.`,
    );
  }
  return matches[0]!.restartPoint;
}
