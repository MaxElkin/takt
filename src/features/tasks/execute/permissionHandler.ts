/**
 * permissionHandler — provider permission requests, answered by the human.
 *
 * Providers that can ask before running a tool (claude-sdk, claude-terminal,
 * deepseek-harness) deliver the request here. Without a handler the provider
 * decides alone and the step silently loses the tool call, so this exists to
 * keep `permission_mode` a floor that auto-allows rather than a ceiling that
 * quietly denies.
 */

import type {
  PermissionRequest,
  PermissionResult,
  PermissionUpdate,
} from '../../../core/workflow/index.js';
import { promptLine } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { enterInputWait, leaveInputWait } from './inputWait.js';
import type { OutputFns } from './outputFns.js';
import type { StreamDisplay } from '../../../shared/ui/index.js';

/** Longest tool input rendered above the menu before it is truncated. */
const MAX_INPUT_PREVIEW = 400;

/**
 * The single most informative field of a tool input, or the whole thing.
 *
 * A permission prompt is only useful if it says what is about to run, and for
 * the tools that actually get gated that is one well-known field.
 */
function describeInput(input: Record<string, unknown>): string {
  for (const key of [
    'command',
    'CommandLine',
    'cmd',
    'file_path',
    'TargetFile',
    'AbsolutePath',
    'path',
    'DirectoryPath',
    'SearchDirectory',
    'SearchPath',
    'url',
    'Url',
    'pattern',
    'Pattern',
  ]) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  const fallback = input.toolAction ?? input.tool_action ?? input.toolSummary ?? input.tool_summary ?? input.Description ?? input.description ?? input.explanation;
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback.trim();
  return JSON.stringify(input);
}

export interface PermissionContextItem {
  readonly label: string;
  readonly text: string;
}

export function extractPermissionContext(
  input: Record<string, unknown>,
  primaryText?: string,
): PermissionContextItem[] {
  const items: PermissionContextItem[] = [];

  const add = (label: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      const text = value.trim();
      if (primaryText !== undefined && text === primaryText.trim()) return;
      if (items.some((item) => item.text === text)) return;
      items.push({ label, text });
    }
  };

  add('Action', input.toolAction ?? input.tool_action);
  add('Summary', input.toolSummary ?? input.tool_summary);
  add('Reason', input.explanation ?? input.reason);
  add('Description', input.Description ?? input.description);
  add('Instruction', input.Instruction ?? input.instruction);

  return items;
}

function truncate(text: string): string {
  return text.length > MAX_INPUT_PREVIEW ? `${text.slice(0, MAX_INPUT_PREVIEW)}…` : text;
}

/** Human-readable rule text, e.g. `Bash(git log:*)`. */
function formatRule(rule: { toolName: string; ruleContent?: string }): string {
  return rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`;
}

/**
 * A menu label for one harness-proposed update.
 *
 * The suggestions are computed by the provider's own harness — these are the
 * same choices its interactive prompt would offer — so they are rendered as
 * they arrive rather than reinterpreted.
 */
const SCOPED_MODE_LABELS: Readonly<Record<string, string>> = {
  'acceptEdits:cliArg': 'workflow.permission.allowTurnSandboxed',
  'acceptEdits:session': 'workflow.permission.allowRunSandboxed',
  'bypassPermissions:cliArg': 'workflow.permission.allowTurnUnsandboxed',
  'bypassPermissions:session': 'workflow.permission.allowRunUnsandboxed',
};

function describeSuggestion(update: PermissionUpdate): string {
  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
      return getLabel('workflow.permission.allowRule', undefined, {
        rules: update.rules.map(formatRule).join(', '),
        destination: update.destination,
      });
    case 'removeRules':
      return getLabel('workflow.permission.removeRule', undefined, {
        rules: update.rules.map(formatRule).join(', '),
        destination: update.destination,
      });
    case 'addDirectories':
      return getLabel('workflow.permission.addDirectories', undefined, {
        directories: update.directories.join(', '),
        destination: update.destination,
      });
    case 'removeDirectories':
      return getLabel('workflow.permission.removeDirectories', undefined, {
        directories: update.directories.join(', '),
        destination: update.destination,
      });
    case 'setMode': {
      // `cliArg` scopes a grant to the turn being resumed, `session` to the
      // rest of the run. `bypassPermissions` is the one that drops the
      // sandbox; `acceptEdits` keeps it and lifts only the grant gate. Any
      // other combination falls through to the generic label rather than
      // being described as something it is not.
      const scopedLabel = SCOPED_MODE_LABELS[`${update.mode}:${update.destination}`];
      if (scopedLabel !== undefined) {
        return getLabel(scopedLabel);
      }
      return getLabel('workflow.permission.setMode', undefined, {
        mode: update.mode,
        destination: update.destination,
      });
    }
    default:
      return JSON.stringify(update);
  }
}

function sanitizePermissionText(text: string): string {
  return sanitizeTerminalText(text);
}

/**
 * The numbered choices for one request: allow once (where the provider can
 * honour it), each suggestion, then deny.
 *
 * Plain numbered text rather than a cursor menu, so the prompt is answerable by
 * anything that can write a line — a person at a terminal, or an agent driving
 * `takt` through a pipe.
 */
export function buildPermissionOptions(request: PermissionRequest): string[] {
  return [
    // Omitted by providers that cannot allow one call — see `allowOnce`. It
    // would otherwise be offered as a distinct choice and then resolve to the
    // same grant as the first suggestion.
    ...(request.allowOnce === false ? [] : [getLabel('workflow.permission.allowOnce')]),
    ...(request.suggestions ?? []).map(describeSuggestion),
    getLabel('workflow.permission.deny'),
  ].map(sanitizePermissionText);
}

/**
 * The decision a typed answer stands for.
 *
 * Numbers corresponding to listed allow options are obeyed.
 * Explicit deny choice (the last listed option), blank answers, and out-of-range
 * or invalid numbers deny with the default denial message.
 * Any other non-numeric text (such as custom feedback or instructions) also
 * denies, using the entered text directly as the denial message for the agent.
 */
export function resolvePermissionChoice(
  request: PermissionRequest,
  answer: string | null,
): PermissionResult {
  const defaultDenied: PermissionResult = {
    behavior: 'deny',
    message: getLabel('workflow.permission.denyMessage'),
  };
  if (answer === null) return defaultDenied;
  const normalizedAnswer = answer.trim();
  if (normalizedAnswer.length === 0) return defaultDenied;

  // Numeric inputs: allow choices or default deny for out-of-bounds / No choice
  if (/^[-+]?\d+(?:\.\d+)?$/.test(normalizedAnswer)) {
    if (/^[1-9]\d*$/.test(normalizedAnswer)) {
      const choice = Number(normalizedAnswer);
      const options = buildPermissionOptions(request);
      if (Number.isSafeInteger(choice) && choice >= 1 && choice <= options.length) {
        if (choice === options.length) return defaultDenied;
        const hasAllowOnce = request.allowOnce !== false;
        if (hasAllowOnce && choice === 1) return { behavior: 'allow', updatedInput: request.input };
        const update = request.suggestions?.[choice - (hasAllowOnce ? 2 : 1)];
        if (update !== undefined) {
          return { behavior: 'allow', updatedInput: request.input, updatedPermissions: [update] };
        }
        return { behavior: 'allow', updatedInput: request.input };
      }
    }
    return defaultDenied;
  }

  // Any non-numeric input denies with the entered text as the message
  return {
    behavior: 'deny',
    message: normalizedAnswer,
  };
}

/**
 * Serialises prompts across concurrently running steps.
 *
 * Parallel, arpeggio and team-leader steps all run sub-steps at once in this
 * process against one stdin, so two agents can reach a permission request
 * simultaneously and would otherwise render two menus over each other.
 */
let promptQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = promptQueue.then(task, task);
  promptQueue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Creates the permission handler (used only when the terminal can be prompted).
 */
export function createPermissionHandler(
  out: OutputFns,
  displayRef: { current: StreamDisplay | null },
): (request: PermissionRequest) => Promise<PermissionResult> {
  return async (request: PermissionRequest): Promise<PermissionResult> => enqueue(async () => {
    if (request.signal?.aborted === true) return resolvePermissionChoice(request, null);
    if (displayRef.current) { displayRef.current.flush(); displayRef.current = null; }
    out.blankLine();
    const safeToolName = sanitizePermissionText(request.toolName);
    out.warn(getLabel('workflow.permission.requested', undefined, { tool: safeToolName }));
    const primaryInputText = describeInput(request.input);
    out.info(truncate(sanitizePermissionText(primaryInputText)));

    const contextItems = extractPermissionContext(request.input, primaryInputText);
    for (const item of contextItems) {
      out.info(truncate(sanitizePermissionText(`  ${item.label}: ${item.text}`)));
    }

    if (request.decisionReason !== undefined && request.decisionReason.trim().length > 0) {
      out.info(sanitizePermissionText(request.decisionReason.trim()));
    }

    buildPermissionOptions(request).forEach((label, index) => {
      out.logLine(`  ${String(index + 1)}. ${label}`);
    });

    enterInputWait();
    try {
      const answer = await promptLine(
        getLabel('workflow.permission.question', undefined, { tool: safeToolName }),
        request.signal,
      );
      return resolvePermissionChoice(request, answer);
    } finally {
      leaveInputWait();
    }
  });
}
