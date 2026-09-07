import { callAntigravity } from '../antigravity/client.js';
import type { AntigravityCallOptions } from '../antigravity/types.js';
import type { AgentResponse } from '../../core/models/index.js';
import {
  assertOutputSchema,
  type AgentSetup,
  type Provider,
  type ProviderAgent,
  type ProviderCallOptions,
} from './types.js';

function toAntigravityOptions(options: ProviderCallOptions): AntigravityCallOptions {
  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    effort: options.effort,
    permissionMode: options.permissionMode,
    outputSchema: options.outputSchema,
    onStream: options.onStream,
    onPermissionRequest: options.onPermissionRequest,
    callTimeoutMs: options.providerOptions?.antigravity?.guards?.callTimeoutMs,
    childProcessEnv: options.childProcessEnv,
  };
}

/**
 * Proof of concept. `agy` covers the two things a workflow step needs - a
 * non-interactive turn and `--json-schema` structured output - and nothing
 * else here is wired up: no MCP, no tool allowlist, no images, no max_turns,
 * and no failure taxonomy beyond SUCCESS.
 *
 * The missing allowlist is the one with teeth: `edit: false` on a step cannot
 * be enforced against this provider, only asked for in the prompt.
 */
export class AntigravityProvider implements Provider {
  readonly supportsStructuredOutput = true;
  readonly supportsIsolatedStructuredExecution = true;
  readonly supportsNativeImageInput = false;

  getRuntimeInstructions(_allowedTools?: string[]): string | null {
    return null;
  }

  keepsAllowedToolWithoutEdit(_tool: string): boolean {
    return false;
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> =>
        callAntigravity(name, prompt, {
          ...toAntigravityOptions(options),
          systemPrompt: systemPrompt ?? undefined,
        }),
    };
  }

  setupIsolatedStructured(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    return {
      call: (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => callAntigravity(
        name,
        systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt,
        {
          ...toAntigravityOptions({
            ...options,
            sessionId: undefined,
            outputSchema: assertOutputSchema(options.outputSchema, 'antigravity'),
          }),
        },
      ),
    };
  }
}
