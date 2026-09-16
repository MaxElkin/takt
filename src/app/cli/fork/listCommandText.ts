/**
 * Fork: correct the upstream `takt list` help text, which describes branches
 * although the command lists tasks. Applied after commands.ts registers it.
 */

import { program } from '../program.js';

const list = program.commands.find((command) => command.name() === 'list');
list?.description('List tasks with their status and act on them');

const action = list?.options.find((option) => option.long === '--action');
if (action) {
  action.description = 'Non-interactive action on a completed task branch (diff|sync|try|merge|delete)';
}
