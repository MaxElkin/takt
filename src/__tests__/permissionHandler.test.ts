import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { PermissionRequest } from '../core/workflow/index.js';
import type { OutputFns } from '../features/tasks/execute/outputFns.js';

const { promptLineMock } = vi.hoisted(() => ({
  promptLineMock: vi.fn(),
}));

vi.mock('../shared/prompt/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/prompt/index.js')>(),
  promptLine: promptLineMock,
}));

import {
  buildPermissionOptions,
  createPermissionHandler,
  resolvePermissionChoice,
} from '../features/tasks/execute/permissionHandler.js';

const request: PermissionRequest = {
  toolName: 'Bash',
  input: { command: 'mkdir -p /tmp/probe', description: 'Create probe directory' },
  suggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p /tmp/probe' }],
      behavior: 'allow',
      destination: 'localSettings',
    },
    { type: 'addDirectories', directories: ['/tmp'], destination: 'session' },
  ],
  blockedPath: '/tmp/probe',
};

describe('buildPermissionOptions', () => {
  it('offers allow-once, every suggestion, then deny', () => {
    expect(buildPermissionOptions(request)).toHaveLength(4);
  });

  it('renders a suggestion as the rule it would add', () => {
    const options = buildPermissionOptions(request);
    expect(options[1]).toContain('Bash(mkdir -p /tmp/probe)');
    expect(options[1]).toContain('localSettings');
  });

  it('still offers allow-once and deny when the harness suggests nothing', () => {
    expect(buildPermissionOptions({ toolName: 'Bash', input: {} })).toHaveLength(2);
  });

  it('sanitizes provider-controlled suggestion text', () => {
    const options = buildPermissionOptions({
      toolName: 'Bash',
      input: {},
      suggestions: [{
        type: 'addRules',
        rules: [{ toolName: 'Bash\u001b[2J', ruleContent: 'git status\nspoofed' }],
        behavior: 'allow',
        destination: 'session',
      }],
    });

    expect(options[1]).not.toContain('\u001b');
    expect(options[1]).toContain('\\n');
  });
});

describe('resolvePermissionChoice', () => {
  it('allows once without carrying a permission update', () => {
    expect(resolvePermissionChoice(request, '1')).toEqual({
      behavior: 'allow',
      updatedInput: request.input,
    });
  });

  it('tolerates surrounding whitespace, as a piped answer carries', () => {
    expect(resolvePermissionChoice(request, ' 1 \n').behavior).toBe('allow');
  });

  it('hands the chosen update back for the harness to persist', () => {
    expect(resolvePermissionChoice(request, '2')).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [request.suggestions?.[0]],
    });
  });

  it('maps the last number to deny with default message', () => {
    expect(resolvePermissionChoice(request, '4')).toEqual({
      behavior: 'deny',
      message: 'Denied by the user',
    });
  });

  it('passes non-numeric text as the denial reason to the agent', () => {
    expect(resolvePermissionChoice(request, 'use /tmp instead')).toEqual({
      behavior: 'deny',
      message: 'use /tmp instead',
    });
    expect(resolvePermissionChoice(request, 'do not create files in ~/')).toEqual({
      behavior: 'deny',
      message: 'do not create files in ~/',
    });
  });

  // No answer must never be read as consent: an exhausted pipe, a closed
  // terminal and a pressed Escape all arrive here as null.
  it('denies when there is no answer', () => {
    expect(resolvePermissionChoice(request, null)).toEqual({
      behavior: 'deny',
      message: 'Denied by the user',
    });
  });

  it.each(['yes', '', '0', '5', '-1', '1yes', '1.5', '2 anything', '01'])('denies an unusable answer %j', (answer) => {
    expect(resolvePermissionChoice(request, answer).behavior).toBe('deny');
  });
});

describe('createPermissionHandler', () => {
  beforeEach(() => {
    promptLineMock.mockReset();
    promptLineMock.mockResolvedValue(null);
  });

  it('sanitizes every provider-controlled value before terminal output', async () => {
    const calls: string[] = [];
    const record = (value = ''): void => { calls.push(value); };
    const out: OutputFns = {
      header: record,
      info: record,
      warn: record,
      error: record,
      success: record,
      status: record,
      blankLine: record,
      logLine: record,
    };
    const handler = createPermissionHandler(out, { current: null });

    await handler({
      toolName: 'Bash\u001b[2J',
      input: { command: 'git status\rspoofed' },
      decisionReason: 'reason\u001b]0;owned\u0007',
      suggestions: [{
        type: 'addDirectories',
        directories: ['/tmp\nspoofed'],
        destination: 'session',
      }],
    });

    expect(calls.join('\n')).not.toContain('\u001b');
    expect(calls.join('\n')).not.toContain('\u0007');
    expect(calls.join('\n')).toContain('\\r');
    expect(calls.join('\n')).toContain('\\n');
  });

  it('passes the provider abort signal to the input prompt', async () => {
    const noop = (): void => {};
    const out: OutputFns = {
      header: noop,
      info: noop,
      warn: noop,
      error: noop,
      success: noop,
      status: noop,
      blankLine: noop,
      logLine: noop,
    };
    const signal = new AbortController().signal;

    await createPermissionHandler(out, { current: null })({
      toolName: 'Bash',
      input: {},
      signal,
    });

    expect(promptLineMock).toHaveBeenCalledWith(expect.any(String), signal);
  });

  it('renders all present context items (action, reason, description) in prompt output', async () => {
    const calls: string[] = [];
    const record = (value = ''): void => { calls.push(value); };
    const out: OutputFns = {
      header: record,
      info: record,
      warn: record,
      error: record,
      success: record,
      status: record,
      blankLine: record,
      logLine: record,
    };
    const handler = createPermissionHandler(out, { current: null });

    await handler({
      toolName: 'RunCommand',
      input: {
        command: 'mkdir -p /tmp/probe',
        toolAction: 'Creating temporary directory',
        toolSummary: 'Directory creation',
        explanation: 'Testing permission probe execution',
        Description: 'Set up temporary directory for tests',
      },
    });

    const output = calls.join('\n');
    expect(output).toContain('mkdir -p /tmp/probe');
    expect(output).toContain('Action: Creating temporary directory');
    expect(output).toContain('Summary: Directory creation');
    expect(output).toContain('Reason: Testing permission probe execution');
    expect(output).toContain('Description: Set up temporary directory for tests');
  });
});

describe('scoped setMode labels', () => {
  it('names each turn/run grant by its sandbox state', () => {
    const request = {
      toolName: 'run_command',
      input: {},
      suggestions: [
        { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'cliArg' as const },
        { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
        { type: 'setMode' as const, mode: 'bypassPermissions' as const, destination: 'cliArg' as const },
        { type: 'setMode' as const, mode: 'bypassPermissions' as const, destination: 'session' as const },
      ],
    };

    expect(buildPermissionOptions(request)).toEqual([
      'Allow once',
      'Allow all commands - sandboxed - this turn',
      'Allow all commands - sandboxed - rest of run',
      'Allow all commands - NOT sandboxed - this turn',
      'Allow all commands - NOT sandboxed - rest of run',
      'Deny',
    ]);
  });

  it('drops the allow-once row when the provider cannot honour it', () => {
    const request = {
      toolName: 'run_command',
      input: {},
      allowOnce: false,
      suggestions: [
        { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'cliArg' as const },
        { type: 'setMode' as const, mode: 'bypassPermissions' as const, destination: 'cliArg' as const },
      ],
    };

    expect(buildPermissionOptions(request)).toEqual([
      'Allow all commands - sandboxed - this turn',
      'Allow all commands - NOT sandboxed - this turn',
      'Deny',
    ]);
    // The suggestions shift up by one, so `1` has to reach the first of them
    // rather than the allow-once that is no longer on screen.
    expect(resolvePermissionChoice(request, '1')).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [request.suggestions[0]],
    });
    expect(resolvePermissionChoice(request, '2')).toMatchObject({
      behavior: 'allow',
      updatedPermissions: [request.suggestions[1]],
    });
    expect(resolvePermissionChoice(request, '3').behavior).toBe('deny');
  });

  it('falls back to the generic label for other setMode combinations', () => {
    const request = {
      toolName: 'Bash',
      input: {},
      suggestions: [
        { type: 'setMode' as const, mode: 'plan' as const, destination: 'projectSettings' as const },
      ],
    };

    expect(buildPermissionOptions(request)[1]).toContain('plan');
  });
});
