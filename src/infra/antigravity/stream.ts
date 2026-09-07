import type { ProviderUsageSnapshot } from '../../core/models/response.js';

/**
 * `agy --output-format stream-json` emits NDJSON discriminated on `event`,
 * not on Anthropic's `type`. Three kinds are relevant: `init` (carries the
 * conversation id), `step_update` (carries `text_delta`), and `result`
 * (carries the whole reply, the status, and any structured output).
 */
interface AntigravityUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_tokens?: number;
}

export interface AntigravityDeniedAction {
  action: string;
  display_name?: string;
}

export interface AntigravityStreamResult {
  conversationId?: string;
  /**
   * Non-JSON lines agy prints on stdout. It reports a refused tool permission
   * this way - as prose, on stdout, alongside a `SUCCESS` result - so dropping
   * unparseable lines loses the only account of why a turn produced nothing.
   */
  diagnostics: string[];
  /** Text assembled from `text_delta`, used when `result` never arrives. */
  streamedText: string;
  status?: string;
  response?: string;
  structuredOutput?: Record<string, unknown>;
  usage?: AntigravityUsage;
  sawResult: boolean;
  deniedActions?: AntigravityDeniedAction[];
  lastToolCall?: {
    toolName?: string;
    input?: Record<string, unknown>;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseAsRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct !== undefined) return direct;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      return asRecord(JSON.parse(value.trim()));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractToolCall(source: Record<string, unknown> | undefined): {
  toolName?: string;
  input?: Record<string, unknown>;
} | undefined {
  if (source === undefined) return undefined;

  const toolInfo = asRecord(source.tool_info);
  const toolCalls = Array.isArray(source.tool_calls) && source.tool_calls.length > 0
    ? asRecord(source.tool_calls[0])
    : undefined;
  const singleToolCall = asRecord(source.tool_call) ?? toolCalls;

  const toolName =
    readString(source, 'tool_name')
    ?? readString(source, 'name')
    ?? readString(source, 'tool')
    ?? readString(toolInfo, 'tool_name')
    ?? readString(toolInfo, 'name')
    ?? readString(singleToolCall, 'tool_name')
    ?? readString(singleToolCall, 'name');

  const rawInput =
    parseAsRecord(toolInfo?.parameters)
    ?? parseAsRecord(toolInfo?.params)
    ?? parseAsRecord(toolInfo?.arguments)
    ?? parseAsRecord(toolInfo?.args)
    ?? parseAsRecord(singleToolCall?.parameters)
    ?? parseAsRecord(singleToolCall?.params)
    ?? parseAsRecord(singleToolCall?.arguments)
    ?? parseAsRecord(singleToolCall?.args)
    ?? parseAsRecord(singleToolCall?.input)
    ?? parseAsRecord(source.parameters)
    ?? parseAsRecord(source.params)
    ?? parseAsRecord(source.arguments)
    ?? parseAsRecord(source.args)
    ?? parseAsRecord(source.input)
    ?? parseAsRecord(source.tool_input);

  let input = rawInput !== undefined ? { ...rawInput } : undefined;
  if (input === undefined && toolInfo !== undefined) {
    const keys = Object.keys(toolInfo).filter((k) => k !== 'tool_name' && k !== 'name');
    if (keys.length > 0) {
      input = { ...toolInfo };
    }
  }

  const toolAction =
    readString(input, 'toolAction')
    ?? readString(input, 'tool_action')
    ?? readString(toolInfo, 'toolAction')
    ?? readString(toolInfo, 'tool_action')
    ?? readString(singleToolCall, 'toolAction')
    ?? readString(singleToolCall, 'tool_action')
    ?? readString(source, 'toolAction')
    ?? readString(source, 'tool_action');

  const toolSummary =
    readString(input, 'toolSummary')
    ?? readString(input, 'tool_summary')
    ?? readString(toolInfo, 'toolSummary')
    ?? readString(toolInfo, 'tool_summary')
    ?? readString(singleToolCall, 'toolSummary')
    ?? readString(singleToolCall, 'tool_summary')
    ?? readString(source, 'toolSummary')
    ?? readString(source, 'tool_summary');

  const explanation =
    readString(input, 'explanation')
    ?? readString(toolInfo, 'explanation')
    ?? readString(singleToolCall, 'explanation')
    ?? readString(source, 'explanation');

  const description =
    readString(input, 'Description')
    ?? readString(input, 'description')
    ?? readString(toolInfo, 'Description')
    ?? readString(toolInfo, 'description')
    ?? readString(singleToolCall, 'Description')
    ?? readString(singleToolCall, 'description')
    ?? readString(source, 'Description')
    ?? readString(source, 'description');

  const instruction =
    readString(input, 'Instruction')
    ?? readString(input, 'instruction')
    ?? readString(toolInfo, 'Instruction')
    ?? readString(toolInfo, 'instruction')
    ?? readString(singleToolCall, 'Instruction')
    ?? readString(singleToolCall, 'instruction')
    ?? readString(source, 'Instruction')
    ?? readString(source, 'instruction');

  if (input === undefined) {
    const command = readString(source, 'CommandLine') ?? readString(source, 'command') ?? readString(source, 'cmd');
    if (command !== undefined) {
      input = { command };
    }
  }

  if (toolAction !== undefined || toolSummary !== undefined || explanation !== undefined || description !== undefined || instruction !== undefined) {
    input = input ?? {};
    if (toolAction !== undefined && input.toolAction === undefined) input.toolAction = toolAction;
    if (toolSummary !== undefined && input.toolSummary === undefined) input.toolSummary = toolSummary;
    if (explanation !== undefined && input.explanation === undefined) input.explanation = explanation;
    if (description !== undefined && input.Description === undefined) input.Description = description;
    if (instruction !== undefined && input.Instruction === undefined) input.Instruction = instruction;
  }

  if (toolName !== undefined || input !== undefined) {
    return { toolName, input };
  }
  return undefined;
}

export interface AntigravityStreamParser {
  push: (chunk: string) => void;
  finish: () => AntigravityStreamResult;
}

/**
 * A tool starting or ending, lifted out of `step_update`.
 *
 * `agy` reports tools as ordinary step updates rather than as a distinct event
 * kind: `step_type: "tool"` with a `state` of `ACTIVE`, `DONE` or `ERROR`, and
 * a `step_index` that stays the same across that tool's own updates.
 */
export interface AntigravityToolEvent {
  phase: 'started' | 'finished';
  /** Stable within one call, derived from `step_index`. */
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createAntigravityStreamParser(
  onDelta?: (text: string) => void,
  onToolEvent?: (event: AntigravityToolEvent) => void,
): AntigravityStreamParser {
  const result: AntigravityStreamResult = { streamedText: '', sawResult: false, diagnostics: [] };
  let pending = '';
  let finished = false;
  // A tool emits several updates while it runs, so each transition is reported
  // once: the consumer pairs started/finished by id and would double-count
  // otherwise.
  const startedTools = new Set<string>();
  const finishedTools = new Set<string>();
  let syntheticToolIndex = 0;

  const emitToolEvent = (step: Record<string, unknown> | undefined): void => {
    if (onToolEvent === undefined || step === undefined) return;
    if (readString(step, 'step_type') !== 'tool') return;

    const state = readString(step, 'state')?.toUpperCase();
    if (state !== 'ACTIVE' && state !== 'DONE' && state !== 'ERROR') return;

    const stepIndex = readNumber(step, 'step_index');
    const id = stepIndex !== undefined
      ? `agy-step-${String(stepIndex)}`
      // No index to key on, so the pair cannot be matched up; give the start
      // its own id and let it expire rather than closing the wrong tool.
      : `agy-tool-${String(syntheticToolIndex++)}`;

    const extracted = extractToolCall(step);
    const toolName = extracted?.toolName ?? 'unknown';
    const input = extracted?.input ?? {};

    if (state === 'ACTIVE') {
      if (startedTools.has(id)) return;
      startedTools.add(id);
      onToolEvent({ phase: 'started', id, toolName, input, isError: false });
      return;
    }
    // A terminal state for a tool never announced as ACTIVE still has to open
    // before it closes, or the consumer sees an end with no beginning.
    if (!startedTools.has(id)) {
      startedTools.add(id);
      onToolEvent({ phase: 'started', id, toolName, input, isError: false });
    }
    if (finishedTools.has(id)) return;
    finishedTools.add(id);
    onToolEvent({ phase: 'finished', id, toolName, input, isError: state === 'ERROR' });
  };

  const consumeLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      result.diagnostics.push(trimmed);
      return;
    }
    const root = asRecord(parsed);
    if (root === undefined) {
      result.diagnostics.push(trimmed);
      return;
    }

    const event = root.event;
    if (event === 'init') {
      result.conversationId = readString(root, 'conversation_id') ?? result.conversationId;
      return;
    }

    if (event === 'step_update') {
      const step = asRecord(root.step_update);
      result.conversationId = readString(step, 'conversation_id') ?? result.conversationId;
      const extracted = extractToolCall(step) ?? extractToolCall(root);
      if (extracted !== undefined) {
        result.lastToolCall = {
          toolName: extracted.toolName ?? result.lastToolCall?.toolName,
          input: extracted.input ?? result.lastToolCall?.input,
        };
      }
      emitToolEvent(step);
      const delta = readString(step, 'text_delta');
      if (delta !== undefined) {
        result.streamedText += delta;
        onDelta?.(delta);
      }
      return;
    }

    if (event === 'result') {
      const payload = asRecord(root.result);
      if (payload === undefined) return;
      result.sawResult = true;
      result.conversationId = readString(payload, 'conversation_id') ?? result.conversationId;
      result.status = readString(payload, 'status');
      result.response = typeof payload.response === 'string' ? payload.response : undefined;
      result.structuredOutput = asRecord(payload.structured_output);
      result.usage = asRecord(payload.usage) as AntigravityUsage | undefined;
      const extracted = extractToolCall(payload);
      if (extracted !== undefined) {
        result.lastToolCall = {
          toolName: extracted.toolName ?? result.lastToolCall?.toolName,
          input: extracted.input ?? result.lastToolCall?.input,
        };
      }
      if (Array.isArray(payload.denied_actions)) {
        result.deniedActions = payload.denied_actions
          .map((item) => {
            const itemRecord = asRecord(item);
            return {
              action: readString(itemRecord, 'action') ?? '',
              display_name: readString(itemRecord, 'display_name'),
            };
          })
          .filter((item) => item.action.length > 0 || (item.display_name !== undefined && item.display_name.length > 0));
      }
    }
  };

  return {
    push(chunk: string): void {
      if (finished || chunk.length === 0) return;
      pending += chunk;
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        consumeLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf('\n');
      }
    },
    finish(): AntigravityStreamResult {
      if (!finished) {
        finished = true;
        consumeLine(pending);
        pending = '';
      }
      return result;
    },
  };
}

/**
 * Parse the NDJSON stream. Unknown event kinds and unparseable lines are
 * ignored rather than failing the call: this is a PoC against an undocumented
 * format, so an unrecognised line is far likelier than a real protocol error.
 */
export function parseAntigravityStream(
  stdout: string,
  onDelta?: (text: string) => void,
  onToolEvent?: (event: AntigravityToolEvent) => void,
): AntigravityStreamResult {
  const parser = createAntigravityStreamParser(onDelta, onToolEvent);
  parser.push(stdout);
  return parser.finish();
}

export function toUsageSnapshot(usage: AntigravityUsage | undefined): ProviderUsageSnapshot {
  if (usage === undefined) {
    return { usageMissing: true, reason: 'agy result carried no usage' };
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.cache_read_tokens,
    usageMissing: false,
  };
}
