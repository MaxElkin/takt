/**
 * Fork: `takt task` command group.
 *
 * Registered from index.ts right after upstream commands.ts, so the group
 * lives outside upstream's command file.
 */

import type { Command } from 'commander';
import { program } from '../program.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from '../helpers.js';

/**
 * The task a subcommand acts on: `--name`, or `--current` resolved through
 * `current_task` in `.takt/config.yaml`. Reports and returns undefined when
 * neither names a task, so the action simply returns.
 */
async function selectedName(command: Command): Promise<string | undefined> {
  const { getCliExecutionContext } = await import('../initialization.js');
  const { resolveTaskName } = await import('../../../features/tasks/fork/currentTask.js');
  return resolveTaskName(getCliExecutionContext().cwd, command.opts()).name;
}

const task = program
  .command('task')
  .description('Task management commands')
  .helpCommand(false);

task
  .command('add')
  .description('Add a named task for a workflow, without prompts')
  .option('--name <name>', 'Exact task name, also used as the task text (required)')
  .option('--workflow <workflow>', 'Workflow name or path to workflow file (required)')
  .action(async (_opts, command: Command) => {
    const { getCliExecutionContext } = await import('../initialization.js');
    const { addNamedTask } = await import('../../../features/tasks/fork/addNamedTask.js');
    const opts = command.optsWithGlobals();
    await addNamedTask(getCliExecutionContext().cwd, {
      name: typeof opts.name === 'string' ? opts.name : undefined,
      workflow: resolveWorkflowCliOption(opts),
    });
  });

task
  .command('list')
  .description('List tasks as a name, status and workflow table')
  .action(async () => {
    const { getCliExecutionContext } = await import('../initialization.js');
    const { printTaskTable } = await import('../../../features/tasks/fork/printTaskTable.js');
    printTaskTable(getCliExecutionContext().cwd);
  });

task
  .command('tree')
  .description('Show where a task stands in its workflow, as a step tree')
  .option('--name <name>', 'Exact task name (required unless --current)')
  .option('--current', 'Act on the configured current_task instead of --name')
  .option('--full', 'Expand every subworkflow instead of the current step\'s branch')
  .action(async (_opts, command: Command) => {
    const name = await selectedName(command);
    if (name === undefined) return;
    const opts = command.optsWithGlobals();
    const { getCliExecutionContext } = await import('../initialization.js');
    const { printTaskTree } = await import('../../../features/tasks/fork/printTaskTree.js');
    printTaskTree(getCliExecutionContext().cwd, name, { full: opts.full === true });
  });

task
  .command('instruction')
  .description('Print the prompt for the step a task stands on, for use outside TAKT')
  .option('--name <name>', 'Exact task name (required unless --current)')
  .option('--current', 'Act on the configured current_task instead of --name')
  .option(
    '--complete [result]',
    'Print the step\'s rules and output contract; with a result or a step name '
      + '("-" for stdin, "@file"), move the task on',
  )
  .action(async (_opts, command: Command) => {
    const name = await selectedName(command);
    if (name === undefined) return;
    const { getCliExecutionContext } = await import('../initialization.js');
    const { readCompletionResult } = await import('./completionResult.js');
    const { printTaskInstruction } = await import('../../../features/tasks/fork/printTaskInstruction.js');
    const complete = command.opts().complete as string | boolean | undefined;
    const result = typeof complete === 'string' ? readCompletionResult(complete) : undefined;
    if (result === undefined && typeof complete === 'string') return;
    printTaskInstruction(getCliExecutionContext().cwd, name, {
      complete: complete !== undefined,
      ...(result === undefined ? {} : { result }),
    });
  });

task
  .command('resume')
  .description('Resume a failed task by exact name from its saved checkpoint')
  .option('--name <name>', 'Exact task name (required unless --current)')
  .option('--current', 'Act on the configured current_task instead of --name')
  .action(async (_opts, command: Command) => {
    const name = await selectedName(command);
    if (name === undefined) return;
    const { getCliExecutionContext } = await import('../initialization.js');
    const { resumeTask } = await import('../../../features/tasks/restart/index.js');
    await resumeTask(getCliExecutionContext().cwd, name, resolveAgentOverrides(program));
  });

task
  .command('restart')
  .description('Restart a failed or completed task by exact name from its first step')
  .option('--name <name>', 'Exact task name (required unless --current)')
  .option('--current', 'Act on the configured current_task instead of --name')
  .action(async (_opts, command: Command) => {
    const name = await selectedName(command);
    if (name === undefined) return;
    const { getCliExecutionContext } = await import('../initialization.js');
    const { restartTask } = await import('../../../features/tasks/restart/index.js');
    await restartTask(getCliExecutionContext().cwd, name, resolveAgentOverrides(program));
  });

task
  .command('rewind')
  .description('Rewind a pending, failed or completed task to an authored workflow step')
  .option('--name <name>', 'Exact task name (required unless --current)')
  .option('--current', 'Act on the configured current_task instead of --name')
  .option('--workflow <workflow>', 'Workflow reachable from the task\'s own, to narrow --step')
  .option('--step <step>', 'Authored leaf step to start from (required)')
  // Read with the globals: commander stores a subcommand option into the parent
  // when their long names collide, so `--workflow` here and the global `-w` are
  // the same slot and cannot be told apart. Harmless now that rewind only reads
  // it - a workflow the task cannot reach is refused, never written back.
  .action(async (_opts, command: Command) => {
    const name = await selectedName(command);
    const opts = command.optsWithGlobals();
    const step = typeof opts.step === 'string' ? opts.step.trim() : '';
    if (!step) {
      command.error("error: required option '--step <step>' not specified");
    }
    if (name === undefined || !step) return;
    const { getCliExecutionContext } = await import('../initialization.js');
    const { rewindTask } = await import('../../../features/tasks/restart/index.js');
    await rewindTask(getCliExecutionContext().cwd, name, {
      workflow: resolveWorkflowCliOption(opts),
      step,
      agentOverrides: resolveAgentOverrides(program),
    });
  });

task
  .command('delete')
  .description('Delete a task by exact name, after confirmation')
  .option('--name <name>', 'Exact task name (required unless --current)')
  .option('--current', 'Act on the configured current_task instead of --name')
  .action(async (_opts, command: Command) => {
    const name = await selectedName(command);
    if (name === undefined) return;
    const { getCliExecutionContext } = await import('../initialization.js');
    const { deleteNamedTask } = await import('../../../features/tasks/fork/deleteNamedTask.js');
    await deleteNamedTask(getCliExecutionContext().cwd, name);
  });

task
  .command('config')
  .description('Show or set task-scoped project config in .takt/config.yaml')
  .option(
    '--tasks-artifacts-dir <path>',
    'Project-relative parent of per-task artifact directories ("" clears it)',
  )
  .option('--current-task <name>', 'Task that --current resolves to ("" clears it)')
  .action(async (_opts, command: Command) => {
    const { getCliExecutionContext } = await import('../initialization.js');
    const { configureTasks } = await import('../../../features/tasks/fork/configureTasks.js');
    const opts = command.opts();
    configureTasks(getCliExecutionContext().cwd, {
      tasksArtifactsDir: typeof opts.tasksArtifactsDir === 'string' ? opts.tasksArtifactsDir : undefined,
      currentTask: typeof opts.currentTask === 'string' ? opts.currentTask : undefined,
    });
  });

task
  .command('prune')
  .description('Delete runs and task directories no task accounts for, after confirmation')
  .action(async () => {
    const { getCliExecutionContext } = await import('../initialization.js');
    const { pruneOrphans } = await import('../../../features/tasks/fork/pruneOrphans.js');
    await pruneOrphans(getCliExecutionContext().cwd);
  });
