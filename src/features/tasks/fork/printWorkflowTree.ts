/**
 * Fork: `takt workflow tree` command handler.
 *
 * Resolves the workflow the same way the task commands do, so an identifier
 * that works for `takt task add --workflow` works here.
 */

import { loadWorkflowByIdentifier } from '../../../infra/config/index.js';
import { error } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/index.js';
import { formatWorkflowTreeView, renderWorkflowTree } from './workflowTree.js';

export function printWorkflowTree(
  projectDir: string,
  name: string,
  options: { full?: boolean } = {},
): void {
  const workflowConfig = loadWorkflowByIdentifier(name, projectDir, { lookupCwd: projectDir });
  if (!workflowConfig) {
    error(`Workflow not found: ${sanitizeTerminalText(name)}`);
    process.exitCode = 1;
    return;
  }

  console.log(formatWorkflowTreeView(renderWorkflowTree({
    workflowIdentifier: name,
    rootWorkflow: workflowConfig,
    context: { projectCwd: projectDir, lookupCwd: projectDir },
    ...(options.full === true ? { full: true } : {}),
  })));
}
