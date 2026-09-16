import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { program } from '../app/cli/program.js';
import '../app/cli/commands.js';
import '../app/cli/fork/index.js';

function rootCommand(name: string): Command | undefined {
  return program.commands.find((command) => command.name() === name);
}

describe('fork CLI registration', () => {
  it('should register the fork commands after the upstream commands', () => {
    expect(program.commands.at(-1)?.name()).toBe('task');
    expect(program.commands.map((command) => command.name())).not.toContain('restart');
  });

  // The fork adds `tree` to the group upstream already owns, rather than
  // declaring a second `workflow` group, so upstream's own subcommands and
  // their order have to survive the addition.
  it('should append tree to the upstream workflow group', () => {
    const subcommands = rootCommand('workflow')?.commands.map((command) => command.name());

    expect(subcommands?.slice(0, 3)).toEqual(['init', 'doctor', 'inspect']);
    expect(subcommands?.at(-1)).toBe('tree');
    expect(rootCommand('workflow')?.commands.find((command) => command.name() === 'tree')
      ?.options.map((option) => option.flags)).toEqual(['--name <name>', '--full']);
  });

  it('should register task subcommands with only their own non-interactive options', () => {
    const optionFlags = (name: string) => rootCommand('task')
      ?.commands.find((command) => command.name() === name)
      ?.options.map((option) => option.flags);

    expect(rootCommand('task')?.commands.map((command) => command.name())).toEqual(['add', 'list', 'tree', 'instruction', 'resume', 'restart', 'rewind', 'delete', 'config', 'prune']);
    expect(optionFlags('add')).toEqual(['--name <name>', '--workflow <workflow>']);
    expect(optionFlags('list')).toEqual([]);
    expect(optionFlags('tree')).toEqual(['--name <name>', '--current', '--full']);
    expect(optionFlags('instruction')).toEqual(['--name <name>', '--current', '--complete [result]']);
    expect(optionFlags('resume')).toEqual(['--name <name>', '--current']);
    expect(optionFlags('restart')).toEqual(['--name <name>', '--current']);
    expect(optionFlags('rewind')).toEqual(['--name <name>', '--current', '--workflow <workflow>', '--step <step>']);
    expect(optionFlags('delete')).toEqual(['--name <name>', '--current']);
    expect(optionFlags('config')).toEqual(['--tasks-artifacts-dir <path>', '--current-task <name>']);
    expect(optionFlags('prune')).toEqual([]);
  });

  it('should show only the task subcommands in task help', () => {
    const help = rootCommand('task')?.helpInformation() ?? '';

    expect(help).toMatch(/^ {2}add \[options\] {2,}Add a named task/mu);
    expect(help).toMatch(/^ {2}list {2,}List tasks as a name, status and workflow table/mu);
    expect(help).toMatch(/^ {2}tree \[options\] {2,}Show where a task stands in its workflow/mu);
    expect(help).toMatch(/^ {2}instruction \[options\] {2,}Print the prompt for the step a task stands on/mu);
    expect(help).toMatch(/^ {2}resume \[options\] {2,}Resume a failed task by exact name/mu);
    expect(help).toMatch(/^ {2}restart \[options\] {2,}Restart a failed or completed task by exact name/mu);
    expect(help).toMatch(/^ {2}rewind \[options\] {2,}Rewind a pending, failed or completed task/mu);
    expect(help).toMatch(/^ {2}delete \[options\] {2,}Delete a task by exact name, after confirmation/mu);
    expect(help).toMatch(/^ {2}config \[options\] {2,}Show or set task-scoped project config/mu);
    expect(help).toMatch(/^ {2}prune {2,}Delete runs and task directories no task accounts for/mu);
    expect(help).not.toMatch(/^ {2}help /mu);
  });

  it('should leave upstream takt resume without a task argument', () => {
    expect(rootCommand('resume')?.registeredArguments).toEqual([]);
  });

  it('should describe takt list as listing tasks', () => {
    const list = rootCommand('list');

    expect(list?.description()).toBe('List tasks with their status and act on them');
    expect(list?.options.find((option) => option.long === '--action')?.description)
      .toBe('Non-interactive action on a completed task branch (diff|sync|try|merge|delete)');
  });
});
