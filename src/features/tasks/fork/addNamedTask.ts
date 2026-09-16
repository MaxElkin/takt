import { TaskRunner } from '../../../infra/task/index.js';
import { prepareTaskSpecDirectory } from '../../../infra/task/enqueueService.js';
import { error } from '../../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/index.js';
import { saveTaskFile } from '../add/index.js';
import { displayTaskCreationResult } from '../add/worktree-settings.js';
import { determineWorkflow } from '../execute/selectAndExecute.js';

/**
 * Fork: task add command handler.
 *
 * Non-interactive: the name is both the exact task name and the task text, the
 * workflow must resolve, and the task never uses a worktree. Failures set a
 * non-zero exit code instead of prompting.
 */
export async function addNamedTask(
  cwd: string,
  opts: { name?: string; workflow?: string },
): Promise<void> {
  const name = opts.name?.trim();
  if (!name) {
    error("Missing required option '--name <name>'.");
    process.exitCode = 1;
    return;
  }
  if (opts.workflow === undefined) {
    error("Missing required option '--workflow <workflow>'.");
    process.exitCode = 1;
    return;
  }
  if (new TaskRunner(cwd).listAllTaskItems().some((item) => item.name === name)) {
    error(`Task already exists: ${sanitizeTerminalText(name)}`);
    process.exitCode = 1;
    return;
  }

  const workflow = await determineWorkflow(cwd, opts.workflow);
  if (workflow === null) {
    process.exitCode = 1;
    return;
  }

  const settings = { worktree: false };
  // The name is a label, not a specification. Writing it into order.md would
  // make the run open with "Primary spec: order.md" pointing at one word, which
  // outranks the workflow's own instructions; an empty order defers to them.
  const created = await saveTaskFile(
    cwd,
    name,
    { workflow, slug: name, ...settings },
    (saveCwd, saveTaskContent) =>
      prepareTaskSpecDirectory(saveCwd, saveTaskContent, { orderContent: '' }),
  );
  displayTaskCreationResult(created, settings, workflow);
}
