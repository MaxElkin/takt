import { describe, expect, it, vi } from 'vitest';
import {
  createAntigravityStreamParser,
  parseAntigravityStream,
} from '../infra/antigravity/stream.js';

describe('Antigravity stream parsing', () => {
  it('emits complete text deltas before the stream finishes', () => {
    const onDelta = vi.fn();
    const parser = createAntigravityStreamParser(onDelta);

    parser.push('{"event":"step_update","step_update":{"text_delta":"live"}}\n');

    expect(onDelta).toHaveBeenCalledWith('live');
    expect(parser.finish().streamedText).toBe('live');
  });

  it('preserves an event split across process chunks', () => {
    const onDelta = vi.fn();
    const parser = createAntigravityStreamParser(onDelta);

    parser.push('{"event":"step_update","step_update":{"text_');
    expect(onDelta).not.toHaveBeenCalled();
    parser.push('delta":"split"}}\n');

    expect(onDelta).toHaveBeenCalledWith('split');
    expect(parser.finish().streamedText).toBe('split');
  });

  it('keeps the whole-stream parser behavior for callers with buffered output', () => {
    const parsed = parseAntigravityStream([
      '{"event":"init","conversation_id":"conversation-1"}',
      '{"event":"result","result":{"status":"SUCCESS","response":"done"}}',
    ].join('\n'));

    expect(parsed).toMatchObject({
      conversationId: 'conversation-1',
      sawResult: true,
      status: 'SUCCESS',
      response: 'done',
    });
  });

  it('parses denied_actions from the result event', () => {
    const parsed = parseAntigravityStream([
      '{"event":"init","conversation_id":"conv-deny"}',
      '{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
    ].join('\n'));

    expect(parsed.sawResult).toBe(true);
    expect(parsed.deniedActions).toEqual([
      { action: 'command', display_name: 'RunCommand' },
    ]);
  });

  it('captures lastToolCall from step_update', () => {
    const parsed = parseAntigravityStream([
      '{"event":"step_update","step_update":{"tool_name":"run_command","input":{"command":"mkdir -p /tmp/foo"}}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
    ].join('\n'));

    expect(parsed.lastToolCall).toEqual({
      toolName: 'run_command',
      input: { command: 'mkdir -p /tmp/foo' },
    });
  });

  it('captures lastToolCall from step_update tool_info parameters', () => {
    const parsed = parseAntigravityStream([
      '{"event":"step_update","step_update":{"tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"mkdir -p ~/takt-perm-probe-dir"}}}}',
      '{"event":"result","result":{"status":"SUCCESS","response":""}}',
    ].join('\n'));

    expect(parsed.lastToolCall).toEqual({
      toolName: 'run_command',
      input: { CommandLine: 'mkdir -p ~/takt-perm-probe-dir' },
    });
  });

  it('captures lastToolCall from step_update tool_calls with stringified JSON args', () => {
    const parsed = parseAntigravityStream([
      '{"event":"step_update","step_update":{"tool_calls":[{"name":"write_to_file","arguments":"{\\"TargetFile\\":\\"/path/to/file\\"}"}]}}',
      '{"event":"result","result":{"status":"SUCCESS","response":""}}',
    ].join('\n'));

    expect(parsed.lastToolCall).toEqual({
      toolName: 'write_to_file',
      input: { TargetFile: '/path/to/file' },
    });
  });

  it('opens and closes a tool from its step_update states', () => {
    const onToolEvent = vi.fn();
    parseAntigravityStream([
      '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","state":"ACTIVE","text_delta":"thinking"}}',
      '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"run_command","tool_info":{"CommandLine":"npm test"}}}',
      '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}',
      '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"DONE","tool_name":"run_command"}}',
      '{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","state":"DONE","tool_name":"run_command"}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
    ].join('\n'), undefined, onToolEvent);

    // A non-tool step is not a tool, and neither repetition is a second event.
    expect(onToolEvent).toHaveBeenCalledTimes(2);
    expect(onToolEvent).toHaveBeenNthCalledWith(1, {
      phase: 'started',
      id: 'agy-step-2',
      toolName: 'run_command',
      input: { CommandLine: 'npm test' },
      isError: false,
    });
    expect(onToolEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: 'finished',
      id: 'agy-step-2',
      isError: false,
    }));
  });

  it('marks a failed tool and still opens one that only ever reports a terminal state', () => {
    const onToolEvent = vi.fn();
    parseAntigravityStream(
      '{"event":"step_update","step_update":{"step_index":7,"step_type":"tool","state":"ERROR","tool_name":"run_command"}}',
      undefined,
      onToolEvent,
    );

    // An end with no beginning would leave the consumer holding an unmatched
    // pair, so the start is synthesised first.
    expect(onToolEvent.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ phase: 'started', id: 'agy-step-7', isError: false }),
      expect.objectContaining({ phase: 'finished', id: 'agy-step-7', isError: true }),
    ]);
  });

  it('gives each unindexed tool its own id rather than pairing them', () => {
    const onToolEvent = vi.fn();
    parseAntigravityStream([
      '{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}',
      '{"event":"step_update","step_update":{"step_type":"tool","state":"ACTIVE","tool_name":"view_file"}}',
    ].join('\n'), undefined, onToolEvent);

    const ids = onToolEvent.mock.calls.map(([event]) => (event as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  it('preserves non-JSON lines as diagnostics', () => {
    const parsed = parseAntigravityStream([
      'headless soft-deny tool confirmation',
      'Add an allow-rule under permissions.allow in settings.json',
      '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}',
    ].join('\n'));

    expect(parsed.diagnostics).toEqual([
      'headless soft-deny tool confirmation',
      'Add an allow-rule under permissions.allow in settings.json',
    ]);
  });
});
