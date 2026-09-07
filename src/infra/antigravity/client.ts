import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse } from '../../core/models/index.js';
import { crossSpawn } from '../../shared/utils/index.js';
import { resolveAntigravityProject } from './project.js';
import {
  createAntigravityStreamParser,
  toUsageSnapshot,
  type AntigravityStreamResult,
  type AntigravityToolEvent,
} from './stream.js';
import {
  resolveProviderCallTimeoutMs,
  STALE_IN_FLIGHT_TOOL_FACTOR,
} from '../../shared/types/provider-deadline.js';
import { mapToAntigravityPermissionArgs } from './types.js';
import type { AntigravityCallOptions } from './types.js';
import {
  AGENT_FAILURE_CATEGORIES,
  classifyAbortSignalReason,
  createStreamIdleTimeoutFailure,
  formatAgentFailure,
} from '../../shared/types/agent-failure.js';
import {
  buildRateLimitedResponseFields,
  containsRateLimitError,
  containsRateLimitMarker,
} from '../rate-limit/detection.js';
import type { RateLimitInfo } from '../../core/models/response.js';
import type { PermissionUpdate } from '../claude/types.js';

const AGY_COMMAND = 'agy';
const AGY_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
export const AGY_ABORTED_MESSAGE = 'agy execution aborted';
const MAX_PERMISSION_RESUME_DEPTH = 3;

function isTimeoutError(
  status: string | undefined,
  diagnostics: readonly string[],
  stderr: string,
): boolean {
  const text = [status, ...diagnostics, stderr].filter(Boolean).join(' ').toLowerCase();
  return (
    text.includes('deadline_exceeded')
    || text.includes('outcome_deadline_exceeded')
    || text.includes('print-timeout')
  );
}

function detectRateLimit(
  status: string | undefined,
  diagnostics: readonly string[],
  stderr: string,
): { isRateLimited: boolean; text?: string; source: RateLimitInfo['source'] } {
  const allTexts = [status, ...diagnostics, stderr].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  for (const text of allTexts) {
    if (containsRateLimitMarker(text)) {
      return { isRateLimited: true, text, source: 'stream_marker' };
    }
    if (containsRateLimitError(text)) {
      return { isRateLimited: true, text, source: 'sdk_error' };
    }
    const lower = text.toLowerCase();
    if (
      lower.includes('resource_exhausted')
      || lower.includes('quota exceeded')
      || lower.includes('out of credits')
      || lower.includes('failed to refresh g1 credits')
      || lower.includes('resource exhausted')
    ) {
      return { isRateLimited: true, text, source: 'sdk_error' };
    }
  }
  return { isRateLimited: false, source: 'sdk_error' };
}

/**
 * `agy` takes its schema as a file path or a JSON string. A temp file avoids
 * argv length limits and quoting surprises for anything non-trivial.
 */
async function withSchemaFile<T>(
  schema: Record<string, unknown> | undefined,
  run: (schemaPath: string | undefined) => Promise<T>,
): Promise<T> {
  if (schema === undefined) {
    return run(undefined);
  }
  const dir = mkdtempSync(join(tmpdir(), 'takt-agy-'));
  const schemaPath = join(dir, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(schema), 'utf8');
  try {
    // Awaited, not returned: the file has to outlive the child process that
    // reads it, and a bare `return` would delete it as soon as the promise
    // was handed back.
    return await run(schemaPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Go duration literal, which is what `--print-timeout` parses (`5m0s` by default). */
export function formatAgyDuration(milliseconds: number): string {
  return `${String(Math.max(1, Math.round(milliseconds / 1000)))}s`;
}

function buildArgs(
  prompt: string,
  options: AntigravityCallOptions,
  schemaPath: string | undefined,
): string[] {
  const args = ['--print', prompt, '--output-format', 'stream-json'];
  // Without this the run binds to agy's empty default project, which trusts no
  // workspace and carries no grants, so even reading the repository is denied.
  const project = options.project ?? resolveAntigravityProject(options.cwd);
  if (project !== undefined) args.push('--project', project);
  if (options.model !== undefined) args.push('--model', options.model);
  if (options.effort !== undefined) args.push('--effort', options.effort);
  if (schemaPath !== undefined) args.push('--json-schema', schemaPath);
  // agy cannot be told which conversation id to create, only which to resume,
  // so the id is captured from the init event and handed back on later calls.
  if (options.sessionId !== undefined) args.push('--conversation', options.sessionId);
  // agy's print mode has its own deadline, default 5m — twelve times shorter
  // than TAKT's default step budget, and it kills the turn silently apart from
  // a `print-timeout` mention in the error text. Pass TAKT's budget instead,
  // multiplied by the same factor TAKT allows a tool that is still running, so
  // TAKT's deadline is always the one that fires first and agy's is a backstop.
  args.push('--print-timeout', formatAgyDuration(
    resolveProviderCallTimeoutMs(options.callTimeoutMs) * STALE_IN_FLIGHT_TOOL_FACTOR,
  ));
  // A step with no declared mode normally passes no permission flags and takes
  // agy's own defaults. An approved resume still has to lift the grant gate it
  // just answered, so it maps as `edit` — contained by the sandbox, ungated.
  const effectivePermissionMode = options.permissionMode
    ?? (options._approvalGranted === true ? 'edit' : undefined);
  if (effectivePermissionMode !== undefined) {
    args.push(
      ...mapToAntigravityPermissionArgs(effectivePermissionMode, {
        hasPermissionHandler: options.onPermissionRequest !== undefined,
        approvalGranted: options._approvalGranted === true,
      }),
    );
  }
  return args;
}

function runAgy(
  args: string[],
  options: AntigravityCallOptions,
): Promise<{
  parsed: AntigravityStreamResult;
  stderr: string;
  code: number | null;
  aborted: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(AGY_COMMAND, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.childProcessEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parser = createAntigravityStreamParser(
      (delta) => options.onStream?.({ type: 'text', data: { text: delta } }),
      // Reported as ordinary stream events, which is what the engine's
      // inactivity deadline reads: a tool it knows to be in flight extends the
      // budget, and one that never opens does not.
      (event: AntigravityToolEvent) => {
        if (event.phase === 'started') {
          options.onStream?.({
            type: 'tool_use',
            data: { tool: event.toolName, input: event.input, id: event.id },
          });
          return;
        }
        options.onStream?.({
          type: 'tool_result',
          data: { id: event.id, content: '', isError: event.isError },
        });
      },
    );
    let stdoutLength = 0;
    let stderr = '';
    let aborted = false;
    let settled = false;

    const abortHandler = (): void => {
      aborted = true;
      child.kill('SIGTERM');
    };
    options.abortSignal?.addEventListener('abort', abortHandler, { once: true });

    const cleanup = (): void => {
      options.abortSignal?.removeEventListener('abort', abortHandler);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLength >= AGY_MAX_BUFFER_BYTES) return;
      const text = chunk.toString('utf8').slice(0, AGY_MAX_BUFFER_BYTES - stdoutLength);
      stdoutLength += text.length;
      parser.push(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < AGY_MAX_BUFFER_BYTES) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ parsed: parser.finish(), stderr, code, aborted });
    });
  });
}

export function extractFallbackFromDiagnostics(diagnostics: readonly string[]): {
  toolName?: string;
  command?: string;
  filePath?: string;
} {
  for (let i = 0; i < diagnostics.length; i++) {
    const rawLine = diagnostics[i];
    if (rawLine === undefined) continue;
    const line = rawLine.trim();

    // 1. "User denied permission to run command:" / "user denied permission to run command:"
    const userDeniedMatch = /^(?:user\s+denied\s+permission\s+to\s+run\s+command:?)(?:\s*(.+))?$/i.exec(line);
    if (userDeniedMatch) {
      const inlineCmd = userDeniedMatch[1]?.trim();
      if (inlineCmd && inlineCmd.length > 0) {
        return { toolName: 'RunCommand', command: inlineCmd };
      }
      if (i + 1 < diagnostics.length) {
        const nextRaw = diagnostics[i + 1];
        const nextLine = nextRaw ? nextRaw.trim() : '';
        if (nextLine.length > 0) {
          return { toolName: 'RunCommand', command: nextLine };
        }
      }
    }

    // 2. "run_command {"CommandLine":"..."}"
    const runCommandJsonMatch = /(?:run_command|RunCommand)\s*(\{.*\})/i.exec(line);
    const jsonPayload = runCommandJsonMatch?.[1];
    if (jsonPayload !== undefined) {
      try {
        const parsed: unknown = JSON.parse(jsonPayload);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          const cmd = rec.CommandLine ?? rec.command ?? rec.cmd;
          if (typeof cmd === 'string' && cmd.trim().length > 0) {
            return { toolName: 'RunCommand', command: cmd.trim() };
          }
        }
      } catch {
        // ignore json parse failure
      }
    }

    // 3. Permission check failed for command "..."
    const permFailedMatch = /permission\s+check\s+failed\s+for\s+command\s*["':]\s*([^"'\n]+)/i.exec(line);
    const permCmd = permFailedMatch?.[1]?.trim();
    if (permCmd && permCmd.length > 0) {
      return { toolName: 'RunCommand', command: permCmd };
    }

    // 4. File pre-check
    const fileMatch = /(?:write_to_file|edit_file)\s+target=([^\s]+)/i.exec(line);
    const filePath = fileMatch?.[1]?.trim();
    if (filePath && filePath.length > 0) {
      return { toolName: 'write_to_file', filePath };
    }
  }

  return {};
}

/**
 * The most useful account of a failure, preferring what agy said over what its
 * exit code implies.
 */
function describeFailure(
  diagnostics: readonly string[],
  fallback: string | undefined,
  outcome: { stderr: string; code: number | null },
): string {
  if (diagnostics.length > 0) {
    return diagnostics.join('\n');
  }
  const stderr = outcome.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  return fallback ?? `agy exited with code ${outcome.code}`;
}

export async function callAntigravity(
  agentName: string,
  prompt: string,
  options: AntigravityCallOptions,
): Promise<AgentResponse> {
  // agy has no system-prompt flag, so it is prepended to the turn instead.
  const fullPrompt = options.systemPrompt !== undefined && options.systemPrompt.length > 0
    ? `${options.systemPrompt}\n\n${prompt}`
    : prompt;

  const timestamp = new Date();
  let outcome: {
    parsed: AntigravityStreamResult;
    stderr: string;
    code: number | null;
    aborted: boolean;
  };
  try {
    outcome = await withSchemaFile(options.outputSchema, (schemaPath) => runAgy(
      buildArgs(fullPrompt, options, schemaPath),
      options,
    ));
  } catch (error) {
    if (options.abortSignal?.aborted) {
      const failure = classifyAbortSignalReason(options.abortSignal.reason);
      return {
        persona: agentName,
        status: 'error',
        content: '',
        timestamp,
        failureCategory: failure.category,
        error: formatAgentFailure(failure),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      persona: agentName,
      status: 'error',
      content: '',
      timestamp,
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      error: message,
    };
  }

  const parsed = outcome.parsed;

  const content = parsed.response ?? parsed.streamedText;
  const conversationId = parsed.conversationId ?? options.sessionId;
  const base = {
    persona: agentName,
    content: content.trimEnd(),
    timestamp,
    ...(conversationId === undefined ? {} : { sessionId: conversationId }),
    providerUsage: toUsageSnapshot(parsed.usage),
  };

  // 1. Signal abort handling
  if (outcome.aborted || options.abortSignal?.aborted) {
    const failure = classifyAbortSignalReason(options.abortSignal?.reason ?? AGY_ABORTED_MESSAGE);
    return {
      ...base,
      status: 'error',
      failureCategory: failure.category,
      error: formatAgentFailure(failure),
    };
  }

  // 2. Rate limit & quota handling
  const rateLimitOutcome = detectRateLimit(parsed.status, parsed.diagnostics, outcome.stderr);
  if (rateLimitOutcome.isRateLimited) {
    return {
      ...base,
      ...buildRateLimitedResponseFields('antigravity', rateLimitOutcome.source, rateLimitOutcome.text),
    };
  }

  // 3. Timeout / deadline exceeded handling
  if (isTimeoutError(parsed.status, parsed.diagnostics, outcome.stderr)) {
    const failure = createStreamIdleTimeoutFailure(
      describeFailure(parsed.diagnostics, 'agy execution timed out', outcome),
    );
    return {
      ...base,
      status: 'error',
      failureCategory: failure.category,
      error: formatAgentFailure(failure),
    };
  }

  // 4. Soft-denied actions check (permission prompt & resume loop)
  if (parsed.deniedActions && parsed.deniedActions.length > 0) {
    const resumeDepth = options._resumeDepth ?? 0;
    const denied = parsed.deniedActions[0];
    if (denied && options.onPermissionRequest && parsed.conversationId && resumeDepth < MAX_PERMISSION_RESUME_DEPTH) {
      const rawInput = parsed.lastToolCall?.input;
      const diagFallback = extractFallbackFromDiagnostics(parsed.diagnostics);
      const toolName = parsed.lastToolCall?.toolName
        || denied.display_name
        || diagFallback.toolName
        || (denied.action === 'command' ? 'RunCommand' : denied.action)
        || 'tool';
      const input: Record<string, unknown> = {
        ...(rawInput ?? {}),
        ...(rawInput === undefined ? { action: denied.action, tool: toolName } : {}),
      };

      const command =
        (typeof input.CommandLine === 'string' && input.CommandLine.trim().length > 0 ? input.CommandLine.trim() : undefined)
        ?? (typeof input.command === 'string' && input.command.trim().length > 0 ? input.command.trim() : undefined)
        ?? (typeof input.cmd === 'string' && input.cmd.trim().length > 0 ? input.cmd.trim() : undefined)
        ?? diagFallback.command;

      if (command !== undefined) {
        input.command = command;
      }

      const filePath =
        (typeof input.TargetFile === 'string' && input.TargetFile.trim().length > 0 ? input.TargetFile.trim() : undefined)
        ?? (typeof input.AbsolutePath === 'string' && input.AbsolutePath.trim().length > 0 ? input.AbsolutePath.trim() : undefined)
        ?? (typeof input.file_path === 'string' && input.file_path.trim().length > 0 ? input.file_path.trim() : undefined)
        ?? (typeof input.path === 'string' && input.path.trim().length > 0 ? input.path.trim() : undefined)
        ?? diagFallback.filePath;

      if (filePath !== undefined) {
        input.file_path = filePath;
      }

      const dirPath =
        (typeof input.DirectoryPath === 'string' && input.DirectoryPath.trim().length > 0 ? input.DirectoryPath.trim() : undefined)
        ?? (typeof input.SearchDirectory === 'string' && input.SearchDirectory.trim().length > 0 ? input.SearchDirectory.trim() : undefined)
        ?? (typeof input.SearchPath === 'string' && input.SearchPath.trim().length > 0 ? input.SearchPath.trim() : undefined);

      if (dirPath !== undefined && input.path === undefined) {
        input.path = dirPath;
      }

      const url = typeof input.Url === 'string' && input.Url.trim().length > 0 ? input.Url.trim() : undefined;
      if (url !== undefined && input.url === undefined) {
        input.url = url;
      }

      const streamedExplanation = (parsed.response ?? parsed.streamedText).trim();
      if (streamedExplanation.length > 0 && input.explanation === undefined && input.reason === undefined) {
        input.explanation = streamedExplanation;
      }

      const decisionReason = parsed.diagnostics.length > 0 ? parsed.diagnostics.join('\n') : undefined;
      // `agy` cannot honour a per-tool rule: the denied call is already gone, so
      // the only grant it can act on is turn-wide. Offering `addRules` here
      // rendered a choice that was silently dropped, so the two options below
      // are the ones that are actually true — they differ only in whether the
      // sandbox survives, which is the one bit worth reading carefully.
      const suggestions: PermissionUpdate[] = [
        { type: 'setMode', mode: 'acceptEdits', destination: 'cliArg' },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'cliArg' },
      ];

      const decision = await options.onPermissionRequest({
        toolName,
        input,
        suggestions,
        allowOnce: false,
        decisionReason,
        signal: options.abortSignal,
      });

      if (options.abortSignal?.aborted) {
        const failure = classifyAbortSignalReason(options.abortSignal.reason);
        return {
          ...base,
          status: 'error',
          failureCategory: failure.category,
          error: formatAgentFailure(failure),
        };
      }

      if (decision.behavior === 'allow') {
        // `bypassPermissions` is the explicit "no sandbox" choice; anything
        // else (including a bare allow) keeps containment and lifts only the
        // grant gate.
        const dropSandbox = (decision.updatedPermissions ?? []).some(
          (update) => update.type === 'setMode' && update.mode === 'bypassPermissions',
        );
        return callAntigravity(
          agentName,
          'Tool execution was approved by user. Please proceed.',
          {
            ...options,
            sessionId: parsed.conversationId,
            ...(dropSandbox
              ? { permissionMode: 'full' as const }
              : { _approvalGranted: true }),
            _resumeDepth: resumeDepth + 1,
          },
        );
      }

      if (decision.behavior === 'deny' && !decision.interrupt) {
        const denialReason = decision.message && decision.message.trim().length > 0
          ? decision.message.trim()
          : 'Denied by the user';
        const denyPrompt = `User denied permission to run tool '${toolName}'. Reason: ${denialReason}. Please proceed without running this tool or propose an alternative approach.`;
        return callAntigravity(
          agentName,
          denyPrompt,
          {
            ...options,
            sessionId: parsed.conversationId,
            // A denial restores the grant gate even if an earlier action in
            // this chain was approved.
            _approvalGranted: false,
            _resumeDepth: resumeDepth + 1,
          },
        );
      }

      return {
        ...base,
        status: 'error',
        failureCategory: decision.interrupt
          ? AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT
          : AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
        error: decision.message || `Tool execution denied by user: ${toolName}`,
      };
    }

    const deniedNames = parsed.deniedActions.map((a) => a.display_name || a.action).join(', ');
    return {
      ...base,
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      error: describeFailure(parsed.diagnostics, `Tool execution denied: ${deniedNames}`, outcome),
    };
  }

  // 5. Result event check (stream parse error if 0 exit code without result event)
  if (!parsed.sawResult) {
    if (outcome.code === 0) {
      return {
        ...base,
        status: 'error',
        failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_STREAM_PARSE_ERROR,
        error: describeFailure(parsed.diagnostics, 'agy stream completed without a result event', outcome),
      };
    }
    return {
      ...base,
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      error: describeFailure(parsed.diagnostics, `agy process exited with code ${outcome.code}`, outcome),
    };
  }

  // 6. Non-SUCCESS status or non-zero exit code
  const succeeded = parsed.status === 'SUCCESS' && outcome.code === 0;
  if (!succeeded) {
    const detail = describeFailure(
      parsed.diagnostics,
      parsed.status ? `agy reported status: ${parsed.status}` : undefined,
      outcome,
    );
    return {
      ...base,
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      error: detail,
    };
  }

  // 7. Empty response check
  if (base.content.length === 0) {
    return {
      ...base,
      status: 'error',
      failureCategory: AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR,
      error: describeFailure(parsed.diagnostics, 'agy produced no output', outcome),
    };
  }

  // 8. Completed successfully
  return {
    ...base,
    status: 'done',
    ...(parsed.structuredOutput === undefined ? {} : { structuredOutput: parsed.structuredOutput }),
  };
}
