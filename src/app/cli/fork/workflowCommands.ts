/**
 * Fork: additions to the upstream `takt workflow` group.
 *
 * Upstream already owns the group (`init`, `doctor`, `inspect`), so the fork
 * looks it up on the program rather than declaring a second one. That keeps
 * the addition out of upstream's command file entirely - no hook needed.
 */

import type { Command } from 'commander';
import { program } from '../program.js';

function requireWorkflowGroup(): Command {
  const workflow = program.commands.find((command) => command.name() === 'workflow');
  if (workflow === undefined) {
    throw new Error('Fork: upstream `workflow` command group is missing.');
  }
  return workflow;
}

requireWorkflowGroup()
  .command('tree')
  .description('Show a workflow\'s steps as a tree, with subworkflows collapsed')
  .option('--name <name>', 'Workflow name or path to workflow file (required)')
  .option('--full', 'Expand every subworkflow instead of collapsing them')
  .action(async (_opts, command: Command) => {
    const opts = command.optsWithGlobals();
    const name = typeof opts.name === 'string' ? opts.name.trim() : '';
    if (!name) {
      command.error("error: required option '--name <name>' not specified");
    }
    const { getCliExecutionContext } = await import('../initialization.js');
    const { printWorkflowTree } = await import('../../../features/tasks/fork/printWorkflowTree.js');
    printWorkflowTree(getCliExecutionContext().cwd, name, { full: opts.full === true });
  });
