import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_FAILURE_CATEGORIES, createPartTimeoutReason } from '../shared/types/agent-failure.js';

const { crossSpawnMock } = vi.hoisted(() => ({
  crossSpawnMock: vi.fn(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../shared/utils/index.js')>(),
  crossSpawn: crossSpawnMock,
}));

import { callAntigravity } from '../infra/antigravity/client.js';
import { mapToAntigravityPermissionArgs } from '../infra/antigravity/types.js';

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('callAntigravity', () => {
  beforeEach(() => {
    crossSpawnMock.mockReset();
  });
  it('forwards a text delta before agy exits', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);
    const onStream = vi.fn();

    const resultPromise = callAntigravity('reviewer', 'Review', {
      cwd: '/tmp',
      onStream,
    });
    child.stdout.write('{"event":"step_update","step_update":{"text_delta":"live"}}\n');

    expect(onStream).toHaveBeenCalledWith({ type: 'text', data: { text: 'live' } });

    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"live"}}\n');
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({ status: 'done', content: 'live' });
  });

  it('caps agy print mode with TAKT\'s own budget rather than agy\'s 5-minute default', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('reviewer', 'Review', { cwd: '/tmp' });
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
    child.emit('close', 0);
    await resultPromise;

    const args = (crossSpawnMock.mock.calls[0] as [string, string[], unknown])[1];
    // The default 1h step budget, times the factor TAKT allows an in-flight
    // tool, so TAKT's deadline fires first and agy's is only a backstop.
    expect(args).toContain('--print-timeout');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('21600s');
  });

  it('derives the print timeout from a configured call timeout', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('reviewer', 'Review', {
      cwd: '/tmp',
      callTimeoutMs: 120_000,
    });
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
    child.emit('close', 0);
    await resultPromise;

    const args = (crossSpawnMock.mock.calls[0] as [string, string[], unknown])[1];
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('720s');
  });

  it('reports agy tool steps as stream tool events', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);
    const onStream = vi.fn();

    const resultPromise = callAntigravity('coder', 'Build', { cwd: '/tmp', onStream });
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"CommandLine":"npm test"}}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n');
    child.stdout.write('{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"DONE","tool_name":"run_command"}}\n');

    expect(onStream).toHaveBeenNthCalledWith(1, {
      type: 'tool_use',
      data: { tool: 'run_command', input: { CommandLine: 'npm test' }, id: 'agy-step-2' },
    });
    // The repeated ACTIVE is not a second tool call.
    expect(onStream).toHaveBeenNthCalledWith(2, {
      type: 'tool_result',
      data: { id: 'agy-step-2', content: '', isError: false },
    });
    expect(onStream).toHaveBeenCalledTimes(2);

    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n');
    child.emit('close', 0);
    await resultPromise;
  });

  it('prompts user on denied_actions and resumes when allowed', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });

    const resultPromise = callAntigravity('coder', 'Do something risky', {
      cwd: '/tmp',
      onPermissionRequest,
    });

    child1.stdout.write('{"event":"init","conversation_id":"conv-123"}\n');
    child1.stdout.write('{"event":"step_update","step_update":{"tool_name":"run_command","input":{"command":"mkdir /foo"}}}\n');
    child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child1.emit('close', 0);

    // Wait for prompt to be handled and second process spawned
    await vi.waitFor(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'run_command',
          input: { command: 'mkdir /foo' },
        }),
      );
      expect(crossSpawnMock).toHaveBeenCalledTimes(2);
    });

    // Check args of resumed call
    const secondCallArgs = crossSpawnMock.mock.calls[1] as [string, string[], unknown];
    expect(secondCallArgs[1]).toContain('--conversation');
    expect(secondCallArgs[1]).toContain('conv-123');
    expect(secondCallArgs[1]).toContain('--dangerously-skip-permissions');
    // The approval lifts the grant gate, not the sandbox.
    expect(secondCallArgs[1]).toContain('--sandbox');

    child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"created /foo"}}\n');
    child2.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'done',
      content: 'created /foo',
      sessionId: 'conv-123',
    });
  });

  it('resumes conversation with denial feedback when user denies permission', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const onPermissionRequest = vi.fn().mockResolvedValue({
      behavior: 'deny',
      message: 'use /tmp instead',
    });

    const resultPromise = callAntigravity('coder', 'Do something risky', {
      cwd: '/tmp',
      onPermissionRequest,
    });

    child1.stdout.write('{"event":"init","conversation_id":"conv-456"}\n');
    child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child1.emit('close', 0);

    // Wait for prompt to be handled and second process spawned
    await vi.waitFor(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'RunCommand',
        }),
      );
      expect(crossSpawnMock).toHaveBeenCalledTimes(2);
    });

    // Check args of resumed call
    const secondCallArgs = crossSpawnMock.mock.calls[1] as [string, string[], unknown];
    expect(secondCallArgs[1]).toContain('--conversation');
    expect(secondCallArgs[1]).toContain('conv-456');
    const promptArgIdx = secondCallArgs[1].indexOf('--print');
    expect(promptArgIdx).toBeGreaterThanOrEqual(0);
    expect(secondCallArgs[1][promptArgIdx + 1]).toContain("User denied permission to run tool 'RunCommand'. Reason: use /tmp instead.");
    expect(secondCallArgs[1]).not.toContain('--dangerously-skip-permissions');

    child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"ok, using /tmp"}}\n');
    child2.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'done',
      content: 'ok, using /tmp',
      sessionId: 'conv-456',
    });
  });

  it('returns external_abort when user interrupts via permission decision', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const onPermissionRequest = vi.fn().mockResolvedValue({
      behavior: 'deny',
      message: 'Aborted by user',
      interrupt: true,
    });

    const resultPromise = callAntigravity('coder', 'Do something risky', {
      cwd: '/tmp',
      onPermissionRequest,
    });

    child.stdout.write('{"event":"init","conversation_id":"conv-456"}\n');
    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT,
      error: 'Aborted by user',
    });
    expect(crossSpawnMock).toHaveBeenCalledTimes(1);
  });

  it('returns provider_error on denied_actions when onPermissionRequest is omitted', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('coder', 'Do something', {
      cwd: '/tmp',
    });

    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
    });
    expect(result.error).toMatch(/Tool execution denied/i);
  });

  it('detects rate limit errors and emits rate_limited status', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('coder', 'Do something', { cwd: '/tmp' });

    child.stderr.write('gRPC error: RESOURCE_EXHAUSTED: quota exceeded for model\n');
    child.stdout.write('{"event":"result","result":{"status":"ERROR","response":""}}\n');
    child.emit('close', 1);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'rate_limited',
      errorKind: 'rate_limit',
    });
    expect(result.rateLimitInfo?.provider).toBe('antigravity');
  });

  it('classifies external abort signals', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const controller = new AbortController();
    const resultPromise = callAntigravity('coder', 'Do something', {
      cwd: '/tmp',
      abortSignal: controller.signal,
    });

    controller.abort(new Error('user cancelled'));
    child.emit('close', null);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT,
    });
  });

  it('classifies part timeout abort signals', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const controller = new AbortController();
    const resultPromise = callAntigravity('coder', 'Do something', {
      cwd: '/tmp',
      abortSignal: controller.signal,
    });

    controller.abort(new Error(createPartTimeoutReason(5000)));
    child.emit('close', null);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PART_TIMEOUT,
    });
  });

  it('classifies deadline exceeded as stream_idle_timeout', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('coder', 'Do something', { cwd: '/tmp' });

    child.stdout.write('{"event":"result","result":{"status":"DEADLINE_EXCEEDED","response":""}}\n');
    child.emit('close', 1);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT,
    });
  });

  it('classifies process exit 0 without result as provider_stream_parse_error', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('coder', 'Do something', { cwd: '/tmp' });

    child.stdout.write('{"event":"init","conversation_id":"conv-empty"}\n');
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
    });
  });

  it('classifies non-zero process exit as provider_error', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('coder', 'Do something', { cwd: '/tmp' });

    child.stderr.write('fatal crash\n');
    child.emit('close', 42);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      error: 'fatal crash',
    });
  });

  describe('mapToAntigravityPermissionArgs', () => {
    it('maps readonly to --sandbox and --mode plan', () => {
      expect(mapToAntigravityPermissionArgs('readonly')).toEqual(['--sandbox', '--mode', 'plan']);
      expect(mapToAntigravityPermissionArgs('readonly', { hasPermissionHandler: true })).toEqual(['--sandbox', '--mode', 'plan']);
      expect(mapToAntigravityPermissionArgs('readonly', { hasPermissionHandler: false })).toEqual(['--sandbox', '--mode', 'plan']);
    });

    it('maps edit to --sandbox when interactive handler is present', () => {
      expect(mapToAntigravityPermissionArgs('edit', { hasPermissionHandler: true })).toEqual(['--sandbox']);
    });

    it('maps edit to --sandbox and --dangerously-skip-permissions when no handler is present', () => {
      expect(mapToAntigravityPermissionArgs('edit', { hasPermissionHandler: false })).toEqual([
        '--sandbox',
        '--dangerously-skip-permissions',
      ]);
      expect(mapToAntigravityPermissionArgs('edit')).toEqual([
        '--sandbox',
        '--dangerously-skip-permissions',
      ]);
    });

    it('maps full to --dangerously-skip-permissions', () => {
      expect(mapToAntigravityPermissionArgs('full')).toEqual(['--dangerously-skip-permissions']);
    });

    it('drops the sandbox only when bypassPermissions was chosen', async () => {
      const child1 = createMockChild();
      const child2 = createMockChild();
      crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const onPermissionRequest = vi.fn().mockResolvedValue({
        behavior: 'allow',
        updatedPermissions: [
          { type: 'setMode', mode: 'bypassPermissions', destination: 'cliArg' },
        ],
      });

      const resultPromise = callAntigravity('coder', 'Do something risky', {
        cwd: '/tmp',
        permissionMode: 'edit',
        onPermissionRequest,
      });

      child1.stdout.write('{"event":"init","conversation_id":"conv-nosb"}\n');
      child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
      child1.emit('close', 0);

      await vi.waitFor(() => {
        expect(crossSpawnMock).toHaveBeenCalledTimes(2);
      });

      const secondCallArgs = crossSpawnMock.mock.calls[1] as [string, string[], unknown];
      expect(secondCallArgs[1]).toContain('--dangerously-skip-permissions');
      expect(secondCallArgs[1]).not.toContain('--sandbox');

      child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      child2.emit('close', 0);
      await resultPromise;
    });

    it('offers only grants agy can honour', async () => {
      const child1 = createMockChild();
      const child2 = createMockChild();
      crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

      const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });

      const resultPromise = callAntigravity('coder', 'Do something risky', {
        cwd: '/tmp',
        permissionMode: 'edit',
        onPermissionRequest,
      });

      child1.stdout.write('{"event":"init","conversation_id":"conv-sugg"}\n');
      child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
      child1.emit('close', 0);

      await vi.waitFor(() => {
        expect(onPermissionRequest).toHaveBeenCalled();
      });

      // No `addRules`: agy cannot scope a grant to one tool. `allowOnce: false`
      // for the same reason — the denied turn is gone, so allowing "just this
      // call" would resolve to the same turn-wide grant as the first suggestion.
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          allowOnce: false,
          suggestions: [
            { type: 'setMode', mode: 'acceptEdits', destination: 'cliArg' },
            { type: 'setMode', mode: 'bypassPermissions', destination: 'cliArg' },
          ],
        }),
      );

      child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"done"}}\n');
      child2.emit('close', 0);
      await resultPromise;
    });

    it('keeps the sandbox on an approved resume, lifting only the grant gate', () => {
      expect(mapToAntigravityPermissionArgs('edit', {
        hasPermissionHandler: true,
        approvalGranted: true,
      })).toEqual(['--sandbox', '--dangerously-skip-permissions']);
    });

    it('does not raise a readonly or full step through an approved resume', () => {
      expect(mapToAntigravityPermissionArgs('readonly', {
        hasPermissionHandler: true,
        approvalGranted: true,
      })).toEqual(['--sandbox', '--mode', 'plan']);
      expect(mapToAntigravityPermissionArgs('full', {
        hasPermissionHandler: true,
        approvalGranted: true,
      })).toEqual(['--dangerously-skip-permissions']);
    });
  });

  it('runs interactive edit step with --sandbox and prompts on denied_actions', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });

    const resultPromise = callAntigravity('asker', 'Run probe', {
      cwd: '/tmp',
      permissionMode: 'edit',
      onPermissionRequest,
    });

    // Check first call args: should have --sandbox, but NOT --mode plan or --dangerously-skip-permissions
    const firstCallArgs = crossSpawnMock.mock.calls[0] as [string, string[], unknown];
    expect(firstCallArgs[1]).toContain('--sandbox');
    expect(firstCallArgs[1]).not.toContain('--mode');
    expect(firstCallArgs[1]).not.toContain('plan');
    expect(firstCallArgs[1]).not.toContain('--dangerously-skip-permissions');

    child1.stdout.write('{"event":"init","conversation_id":"conv-interactive"}\n');
    child1.stdout.write('{"event":"step_update","step_update":{"tool_name":"run_command","input":{"CommandLine":"mkdir -p ~/takt-perm-probe-dir"}}}\n');
    child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child1.emit('close', 0);

    await vi.waitFor(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'run_command',
          input: expect.objectContaining({
            CommandLine: 'mkdir -p ~/takt-perm-probe-dir',
            command: 'mkdir -p ~/takt-perm-probe-dir',
          }),
        }),
      );
      expect(crossSpawnMock).toHaveBeenCalledTimes(2);
    });

    // Second call resumes with --dangerously-skip-permissions
    const secondCallArgs = crossSpawnMock.mock.calls[1] as [string, string[], unknown];
    expect(secondCallArgs[1]).toContain('--conversation');
    expect(secondCallArgs[1]).toContain('conv-interactive');
    expect(secondCallArgs[1]).toContain('--dangerously-skip-permissions');
    // The approval lifts the grant gate, not the sandbox.
    expect(secondCallArgs[1]).toContain('--sandbox');

    child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"probe done"}}\n');
    child2.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      status: 'done',
      content: 'probe done',
      sessionId: 'conv-interactive',
    });
  });

  it('runs readonly step with --sandbox and --mode plan', async () => {
    const child = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child);

    const resultPromise = callAntigravity('reviewer', 'Read repo', {
      cwd: '/tmp',
      permissionMode: 'readonly',
    });

    const callArgs = crossSpawnMock.mock.calls[0] as [string, string[], unknown];
    expect(callArgs[1]).toContain('--sandbox');
    expect(callArgs[1]).toContain('--mode');
    expect(callArgs[1]).toContain('plan');
    expect(callArgs[1]).not.toContain('--dangerously-skip-permissions');

    child.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"plan done"}}\n');
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      status: 'done',
      content: 'plan done',
    });
  });

  it('extracts command from tool_info.parameters for permission prompt', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });

    const resultPromise = callAntigravity('asker', 'Run probe', {
      cwd: '/tmp',
      permissionMode: 'edit',
      onPermissionRequest,
    });

    child1.stdout.write('{"event":"init","conversation_id":"conv-toolinfo"}\n');
    child1.stdout.write('{"event":"step_update","step_update":{"tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"mkdir -p ~/takt-perm-probe-dir"}}}}\n');
    child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child1.emit('close', 0);

    await vi.waitFor(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'run_command',
          input: expect.objectContaining({
            CommandLine: 'mkdir -p ~/takt-perm-probe-dir',
            command: 'mkdir -p ~/takt-perm-probe-dir',
          }),
        }),
      );
    });

    child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"resumed"}}\n');
    child2.emit('close', 0);
    await resultPromise;
  });

  it('falls back to diagnostics when step_update carries no tool input', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });

    const resultPromise = callAntigravity('asker', 'Run probe', {
      cwd: '/tmp',
      permissionMode: 'edit',
      onPermissionRequest,
    });

    child1.stdout.write('{"event":"init","conversation_id":"conv-diag"}\n');
    child1.stdout.write('User denied permission to run command:\n');
    child1.stdout.write('mkdir -p ~/takt-perm-probe-dir\n');
    child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child1.emit('close', 0);

    await vi.waitFor(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'RunCommand',
          input: expect.objectContaining({
            command: 'mkdir -p ~/takt-perm-probe-dir',
          }),
        }),
      );
    });

    child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"resumed"}}\n');
    child2.emit('close', 0);
    await resultPromise;
  });

  it('uses streamed pre-tool text as explanation when tool parameters lack explanation', async () => {
    const child1 = createMockChild();
    const child2 = createMockChild();
    crossSpawnMock.mockReturnValueOnce(child1).mockReturnValueOnce(child2);

    const onPermissionRequest = vi.fn().mockResolvedValue({ behavior: 'allow' });

    const resultPromise = callAntigravity('asker', 'Run probe', {
      cwd: '/tmp',
      permissionMode: 'edit',
      onPermissionRequest,
    });

    child1.stdout.write('{"event":"init","conversation_id":"conv-stream-exp"}\n');
    child1.stdout.write('{"event":"step_update","step_update":{"text_delta":"I need to create the probe directory to test permissions."}}\n');
    child1.stdout.write('{"event":"step_update","step_update":{"tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"mkdir -p ~/takt-perm-probe-dir"}}}}\n');
    child1.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"I need to create the probe directory to test permissions.","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}\n');
    child1.emit('close', 0);

    await vi.waitFor(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'run_command',
          input: expect.objectContaining({
            command: 'mkdir -p ~/takt-perm-probe-dir',
            explanation: 'I need to create the probe directory to test permissions.',
          }),
        }),
      );
    });

    child2.stdout.write('{"event":"result","result":{"status":"SUCCESS","response":"resumed"}}\n');
    child2.emit('close', 0);
    await resultPromise;
  });
});
