/**
 * Tests for permission mode mapping functions
 */

import { describe, it, expect, vi } from 'vitest';
import { SdkOptionsBuilder, buildSdkOptions } from '../infra/claude/options-builder.js';
import { mapToCodexSandboxMode } from '../infra/codex/types.js';
import type { PermissionMode } from '../core/models/index.js';
import type { ClaudeSpawnOptions } from '../infra/claude/types.js';

describe('SdkOptionsBuilder.mapToSdkPermissionMode', () => {
  it('should map readonly to SDK default', () => {
    expect(SdkOptionsBuilder.mapToSdkPermissionMode('readonly')).toBe('default');
  });

  it('should map edit to SDK acceptEdits', () => {
    expect(SdkOptionsBuilder.mapToSdkPermissionMode('edit')).toBe('acceptEdits');
  });

  it('should map full to SDK bypassPermissions', () => {
    expect(SdkOptionsBuilder.mapToSdkPermissionMode('full')).toBe('bypassPermissions');
  });

  it('should map all PermissionMode values exhaustively', () => {
    const modes: PermissionMode[] = ['readonly', 'edit', 'full'];
    for (const mode of modes) {
      const result = SdkOptionsBuilder.mapToSdkPermissionMode(mode);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    }
  });
});

describe('SdkOptionsBuilder.createCanUseToolCallback', () => {
  it('forwards the SDK abort signal to the permission handler', async () => {
    const handler = vi.fn().mockResolvedValue({ behavior: 'deny', message: 'cancelled' });
    const callback = SdkOptionsBuilder.createCanUseToolCallback(handler);
    const signal = new AbortController().signal;

    await callback('Bash', { command: 'git status' }, { signal });

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

    await callback('Bash', { command: 'ls' }, { signal, suggestions: [harnessSuggestion] });

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

    const first = await callback('Bash', { command: 'ls' }, { signal });
    // `cliArg` is TAKT's own scope marker and must not reach the SDK.
    expect(first).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });

    const second = await callback('Bash', { command: 'date' }, { signal });
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

    const first = await callback('Bash', { command: 'ls' }, { signal });
    expect(first).toMatchObject({ updatedPermissions: [sessionUpdate] });

    await callback('Bash', { command: 'date' }, { signal });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('mapToCodexSandboxMode', () => {
  it('should map readonly to read-only', () => {
    expect(mapToCodexSandboxMode('readonly')).toBe('read-only');
  });

  it('should map edit to workspace-write', () => {
    expect(mapToCodexSandboxMode('edit')).toBe('workspace-write');
  });

  it('should map full to danger-full-access', () => {
    expect(mapToCodexSandboxMode('full')).toBe('danger-full-access');
  });

  it('should map all PermissionMode values exhaustively', () => {
    const modes: PermissionMode[] = ['readonly', 'edit', 'full'];
    for (const mode of modes) {
      const result = mapToCodexSandboxMode(mode);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    }
  });
});

describe('SdkOptionsBuilder.build() — mcpServers', () => {
  it('should include mcpServers in SDK options when provided', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/mcp-server-playwright'],
        },
      },
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should not include mcpServers in SDK options when not provided', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions).not.toHaveProperty('mcpServers');
  });

  it('should include mcpServers alongside other options', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
      allowedTools: ['Read', 'mcp__playwright__*'],
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/mcp-server-playwright'],
        },
      },
      permissionMode: 'edit',
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions.mcpServers).toBeDefined();
    expect(sdkOptions.allowedTools).toEqual(['Read', 'mcp__playwright__*']);
    expect(sdkOptions.permissionMode).toBe('acceptEdits');
  });
});

describe('SdkOptionsBuilder.build() — settingSources', () => {
  it('strict-readonly isolation disables built-in tools, settings, Skills, and external MCP', () => {
    const options = buildSdkOptions({
      cwd: '/test',
      internalAgentIsolation: 'strict-readonly',
      allowedTools: ['Read'],
      mcpServers: {
        docs: { command: 'docs-mcp', args: ['serve'] },
      },
      permissionMode: 'readonly',
      bypassPermissions: false,
      skillsEnabled: true,
    });

    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('mcpServers');
  });

  it('maps readonly permission without changing ordinary Claude settings', () => {
    const options = buildSdkOptions({ cwd: '/test', permissionMode: 'readonly' });

    expect(options.settingSources).toEqual(['project']);
    expect(options).not.toHaveProperty('tools');
    expect(options).not.toHaveProperty('strictMcpConfig');
  });

  it('Given Skills are disabled, When building SDK options, Then it passes an empty Skill allowlist without changing settingSources', () => {
    const options = buildSdkOptions({
      cwd: '/test',
      skillsEnabled: false,
    });

    expect(options.skills).toEqual([]);
    expect(options.settingSources).toEqual(['project']);
  });

  it('Given Skills are enabled, When building SDK options, Then it leaves the SDK Skill option unset for standard discovery', () => {
    const options = buildSdkOptions({
      cwd: '/test',
      skillsEnabled: true,
    });

    expect(options).not.toHaveProperty('skills');
  });

  it('includes project in settingSources', () => {
    const options = buildSdkOptions({ cwd: '/test' });
    expect(options.settingSources).toEqual(['project']);
  });

  it('includes effort when provided', () => {
    const options = buildSdkOptions({ cwd: '/test', effort: 'high' });
    expect(options).toHaveProperty('effort', 'high');
  });

  it('passes only run-local observability snapshot to SDK env', () => {
    const originalTaktObservability = process.env.TAKT_OBSERVABILITY;
    const originalOtlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.TAKT_OBSERVABILITY = '{"enabled":false}';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ambient-user:pass@collector.example.test';

    try {
      const options = buildSdkOptions({
        cwd: '/test',
        childProcessEnv: {
          TAKT_OBSERVABILITY: '{"enabled":true}',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://snapshot-collector.example.test',
        },
      });
      expect(options.env?.TAKT_OBSERVABILITY).toBe('{"enabled":true}');
      expect(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://snapshot-collector.example.test');
    } finally {
      if (originalTaktObservability === undefined) {
        delete process.env.TAKT_OBSERVABILITY;
      } else {
        process.env.TAKT_OBSERVABILITY = originalTaktObservability;
      }
      if (originalOtlpEndpoint === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalOtlpEndpoint;
      }
    }
  });
});
