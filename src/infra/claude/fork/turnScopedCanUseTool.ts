/**
 * Fork: the Claude SDK `canUseTool` callback with turn and run grants.
 * SdkOptionsBuilder.createCanUseToolCallback delegates here.
 */

import type { CanUseTool, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionHandler } from '../types.js';

export function createTurnScopedCanUseTool(handler: PermissionHandler): CanUseTool {
  // Scoped to one provider call, which is one turn: a `cliArg` grant lives
  // exactly as long as this closure. The SDK has no `turn` destination —
  // `session` is the narrowest it persists — so turn scope is TAKT's to
  // keep, and it is deliberately not carried into the next call.
  let turnGranted = false;
  return async (
    toolName: string,
    input: Record<string, unknown>,
    callbackOptions: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
    }
  ): Promise<PermissionResult> => {
    if (turnGranted) {
      return { behavior: 'allow', updatedInput: input };
    }

    // The harness's own suggestions come first — they are the ones it will
    // honour per rule — followed by the two whole-turn/whole-run grants the
    // SDK cannot propose for itself.
    const suggestions: PermissionUpdate[] = [
      ...(callbackOptions.suggestions ?? []),
      { type: 'setMode', mode: 'bypassPermissions', destination: 'cliArg' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
    ];

    const decision = await handler({
      toolName,
      input,
      suggestions,
      blockedPath: callbackOptions.blockedPath,
      decisionReason: callbackOptions.decisionReason,
      signal: callbackOptions.signal,
    });

    if (decision.behavior === 'allow') {
      const updates = decision.updatedPermissions ?? [];
      if (updates.some((u) => u.type === 'setMode' && u.destination === 'cliArg')) {
        turnGranted = true;
        // `cliArg` is TAKT's own scope marker; the SDK would reject it as a
        // settings destination, so it is not forwarded.
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }
    }

    return decision;
  };
}
