import { describe, it, expect, vi } from 'vitest';
import { SdkOptionsBuilder } from '../infra/claude/options-builder.js';

const ids = { toolUseID: 'tool-use-1', requestId: 'request-1' };

describe('SdkOptionsBuilder.createCanUseToolCallback (fork turn scope)', () => {
  it('forwards the SDK abort signal to the permission handler', async () => {
    const handler = vi.fn().mockResolvedValue({ behavior: 'deny', message: 'cancelled' });
    const callback = SdkOptionsBuilder.createCanUseToolCallback(handler);
    const signal = new AbortController().signal;

    await callback('Bash', { command: 'git status' }, { signal, ...ids });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ signal }));
  });

  it('offers the turn and run grants alongside the harness suggestions', async () => {
    const handler = vi.fn().mockResolvedValue({ behavior: 'deny', message: 'no' });
    const callback = SdkOptionsBuilder.createCanUseToolCallback(handler);
    const signal = new AbortController().signal;
    const harnessSuggestion = {
      type: 'addRules' as const,
      rules: [{ toolName: 'Bash' }],
      behavior: 'allow' as const,
      destination: 'session' as const,
    };

    await callback('Bash', { command: 'ls' }, { signal, ...ids, suggestions: [harnessSuggestion] });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestions: [
          harnessSuggestion,
          { type: 'setMode', mode: 'bypassPermissions', destination: 'cliArg' },
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      }),
    );
  });

  it('grants the rest of the turn once cliArg is chosen, without forwarding it', async () => {
    const handler = vi.fn().mockResolvedValue({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
      updatedPermissions: [
        { type: 'setMode', mode: 'bypassPermissions', destination: 'cliArg' },
      ],
    });
    const callback = SdkOptionsBuilder.createCanUseToolCallback(handler);
    const signal = new AbortController().signal;

    const first = await callback('Bash', { command: 'ls' }, { signal, ...ids });
    // `cliArg` is TAKT's own scope marker and must not reach the SDK.
    expect(first).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });

    const second = await callback('Bash', { command: 'date' }, { signal, ...ids });
    expect(second).toEqual({ behavior: 'allow', updatedInput: { command: 'date' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps asking when a session grant is chosen, leaving it to the SDK', async () => {
    const sessionUpdate = {
      type: 'setMode' as const,
      mode: 'bypassPermissions' as const,
      destination: 'session' as const,
    };
    const handler = vi.fn().mockResolvedValue({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [sessionUpdate],
    });
    const callback = SdkOptionsBuilder.createCanUseToolCallback(handler);
    const signal = new AbortController().signal;

    const first = await callback('Bash', { command: 'ls' }, { signal, ...ids });
    expect(first).toMatchObject({ updatedPermissions: [sessionUpdate] });

    await callback('Bash', { command: 'date' }, { signal, ...ids });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
