import type { PermissionMode } from '../../core/models/index.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import type { PermissionHandler } from '../claude/types.js';

/**
 * Map TAKT's PermissionMode onto `agy` argv.
 *
 * In `readonly` mode (`edit: false`), `--sandbox --mode plan` is used so that
 * editing is disabled by the sandbox and planner level without prompting the user.
 *
 * In `edit` mode (`edit: true` or default), when an interactive permission handler
 * is configured (`onPermissionRequest`), `--sandbox` is used without pre-bypassing
 * permissions so that ungranted commands prompt the user via the grant gate.
 * Without an interactive handler, `--dangerously-skip-permissions` is added
 * so unattended runs rely on sandbox containment.
 *
 * In `full` mode, `--dangerously-skip-permissions` auto-approves all tool
 * actions and no sandbox is applied — that is what `full` means.
 *
 * `approvalGranted` marks the resumed turn that follows a human approving one
 * denied action. It lifts the grant gate, because the gate has already been
 * answered and firing it again would only re-ask the same question, but it
 * does not raise the step's mode: an `edit` step resumes under
 * `--sandbox --dangerously-skip-permissions`, still contained. Approving one
 * command must not silently buy an unsandboxed turn, which is what raising the
 * mode to `full` used to do.
 */
export function mapToAntigravityPermissionArgs(
  mode: PermissionMode,
  options?: { hasPermissionHandler?: boolean; approvalGranted?: boolean },
): readonly string[] {
  if (mode === 'full') {
    return ['--dangerously-skip-permissions'];
  }
  if (mode === 'readonly') {
    return ['--sandbox', '--mode', 'plan'];
  }
  if (options?.hasPermissionHandler && options.approvalGranted !== true) {
    return ['--sandbox'];
  }
  return ['--sandbox', '--dangerously-skip-permissions'];
}

/** Options for one `agy --print` call. PoC scope: no MCP, no tool allowlist. */
export interface AntigravityCallOptions {
  cwd: string;
  /** agy project name; resolved from `cwd` when omitted. */
  project?: string;
  abortSignal?: AbortSignal;
  /** `conversation_id` from a previous call; resumed with `--conversation`. */
  sessionId?: string;
  systemPrompt?: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  outputSchema?: Record<string, unknown>;
  onStream?: StreamCallback;
  onPermissionRequest?: PermissionHandler;
  /**
   * TAKT's inactivity budget for the step, in milliseconds. Used to derive
   * `--print-timeout` so agy's own 5-minute default never cuts a turn short of
   * what TAKT would have allowed.
   */
  callTimeoutMs?: number;
  childProcessEnv?: Readonly<Record<string, string>>;
  _resumeDepth?: number;
  /** Set on the turn resumed after a human allowed a denied action. */
  _approvalGranted?: boolean;
}
