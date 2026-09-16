# TAKT fork provider extensions

Part of the [TAKT fork overview](takt-fork-spec.md).

## Antigravity provider

The Antigravity (`agy`) provider's implementation, protocol notes, verified
behavior, constraints, and TODO list are maintained in the canonical
[Antigravity provider specification](antigravity-provider.md).

## Permission prompt

### Problem and behavior

`permission_mode` was a ceiling that silently denied. A provider able to ask
about a tool had nobody to ask, so the request became a denial, the tool call
vanished, and the step carried on missing whatever it needed. With a handler
in place the same setting becomes a floor that auto-allows, and anything above
it asks.

`src/features/tasks/execute/permissionHandler.ts` renders a request as plain
numbered text and turns the typed number back into a `PermissionResult`.

```text
[WARN] Bash needs permission
[INFO] mkdir -p /tmp/probe
[INFO]   Description: Run temporary permission probe
[INFO]   1. Allow once
[INFO]   2. Yes, and always allow Bash(mkdir -p /tmp/probe) (localSettings)
[INFO]   3. Yes, and allow access to /tmp/probe (session)
[INFO]   4. Allow all commands - NOT sandboxed - this turn
[INFO]   5. Allow all commands - NOT sandboxed - rest of run
[INFO]   6. Deny
Allow Bash? Enter choice number, or a reason to deny:
```

Rows 2 and 3 are the harness's own suggestions, rendered as they arrive. Rows
4 and 5 are TAKT's, appended after them.

Four decisions are intentional:

- Plain numbered text is usable by both a person at a terminal and an agent
  driving `takt` through a pipe.
- The last row always denies. Any other non-numeric text also denies, and is
  passed through as the denial message so the agent is told *why*.
- Empty input, exhausted input, numeric prefixes such as `1yes`, decimals, and
  out-of-range indexes all deny.
- Provider-controlled display text is sanitized so tool names, input previews,
  decision reasons, and suggestion labels cannot inject terminal control
  sequences into the prompt.

TAKT never writes a settings file. Suggestions arrive on the request because
the harness computed them; TAKT returns `updatedPermissions` and the harness
persists it. The permission types come from `@anthropic-ai/claude-agent-sdk`,
so the vocabulary of grants belongs to the harness, not TAKT.

### Grant scope

Two axes matter to the human answering, and neither is expressible as a rule
about one tool: **how long** the grant lasts, and **whether the sandbox stays
up**. Both are encoded onto the existing `setMode` update rather than into new
TAKT types, since `PermissionResult` and `PermissionUpdate` are the SDK's.

| | `destination: 'cliArg'` | `destination: 'session'` |
| --- | --- | --- |
| `mode: 'acceptEdits'` | sandboxed, this turn | sandboxed, rest of run |
| `mode: 'bypassPermissions'` | NOT sandboxed, this turn | NOT sandboxed, rest of run |

`cliArg` is TAKT's own marker for turn scope and is never forwarded to a
harness — the SDK has no `turn` destination (`session` is the narrowest thing
it persists), so turn scope is TAKT's to keep. `session` is forwarded and the
harness persists it for the rest of the run.

The labels say `sandboxed` / `NOT sandboxed` and `this turn` / `rest of run`
verbatim, because that is the one bit worth reading carefully in a prompt that
a human answers under time pressure. Any `setMode` combination outside the
four above falls back to a generic `mode/destination` label rather than being
described as something it is not.

### Allow once, where it is real

`PermissionRequest.allowOnce?: boolean` (default true) says whether allowing
this single call is a genuine choice. A provider that resumes a dead turn
rather than releasing a pending call sets it false, and the row is dropped from
the menu; `resolvePermissionChoice` shifts the suggestion index to match, so
`1` reaches the first suggestion.

Antigravity is the case that motivated it. Its denied call is gone by the time
TAKT sees the denial, so a bare allow can only resume the whole turn — which is
already on the menu as "sandboxed - this turn". Offering both rendered two
choices that did the same thing.

### What each provider actually offers

| | `claude-sdk` | `antigravity` | `codex` |
| --- | --- | --- | --- |
| Allow once | yes | — | — |
| Harness rule / directory grants | yes, when it proposes them | — | — |
| Sandboxed, this turn | not yet | yes | — |
| NOT sandboxed, this turn | yes | yes | — |
| NOT sandboxed, rest of run | yes | not yet | — |
| Deny | yes | yes | — |

`claude-sdk` has no sandboxed-turn row because TAKT's `ClaudeSandboxShape`
exposes only `allow_unsandboxed_commands` and `excluded_commands`; the SDK's
`enabled` and `autoAllowBashIfSandboxed` are reachable only from
`.claude/settings.json`, since TAKT passes `settingSources: ['project']`.
Adding the two schema fields would make the row honest.

`antigravity` has no rest-of-run row because a turn-scoped grant is carried as
an argv flag on the resumed turn, and nothing outlives that call. A session
store crossing step boundaries is designed but not built.

`codex` offers nothing: `approvalPolicy: 'never'` is hardcoded in
`src/infra/codex/client.ts` outside the `permission_control` branch, and the
provider never passes `onPermissionRequest`. This is not a TAKT limitation to
undo — `@openai/codex-sdk` shells out to `codex exec`, whose event union is
thread/turn/item/error with no approval event and no approval callback. Probed
directly, `read-only` plus `approval_policy="on-request"` emitted no approval
event at all; the `mkdir` simply failed. `execCommandApproval` exists in the
binary but belongs to the experimental `app-server` transport, so reaching it
means replacing the SDK integration.

### `permission_control: codex`

Setting it hands the sandbox to the project's `.codex/config.toml` and TAKT
sends no `sandboxMode` or `networkAccessEnabled` of its own
(`src/infra/codex/client.ts`). Two consequences follow, and both are properties
of the setting rather than of any one repository:

- A step's `edit:` flag no longer reaches the sandbox. A step that resolves to
  `readonly` still runs under whatever `.codex/config.toml` says — typically
  `workspace-write`. TAKT's per-step permission ladder is traded for one
  repository-wide policy.
- A refused command arrives at the model as an ordinary tool error, which it
  can read and work around. That is the behaviour headless `agy` cannot
  reproduce, and it is the compensation for never being asked.

Verifying which sandbox mode is in force needs a probe that discriminates.
`$HOME` does not: it lies outside both the workspace and `writable_roots`, so
`read-only` and `workspace-write` refuse it alike. `/tmp` does — it is among
`workspace-write`'s default writable roots alongside `$TMPDIR`, and `read-only`
refuses it.

Codex's `execpolicy` rules (`.codex/rules/*.rules`) are not a whitelist: an
unlisted command still runs. Probed with `date`, which appears in no rule and
exited 0 inside a trusted project. A `prompt` rule needs an approval that
`approvalPolicy: 'never'` cannot give, so under TAKT such a command is
expected to be refused rather than asked about; that has not been probed. Rules only apply where the
project is trusted (`trust_level = "trusted"`), which is also why a deny-rule
probe run from an untrusted scratch directory proves nothing.

### Turn scope for `claude-sdk`

`createTurnScopedCanUseTool` (`src/infra/claude/fork/turnScopedCanUseTool.ts`,
returned by `createCanUseToolCallback` in `options-builder.ts`) holds a latch scoped
to one provider call, which is one turn. A `cliArg` grant sets it, and every
later `canUseTool` invocation in that call auto-allows without prompting. It is
deliberately not carried into the next call: a new step is a new turn, and the
grant expires with it.

Two consequences visible from a terminal: "Allow once" really does ask again on
the very next tool call, and a turn grant answered in step 1 does not survive
into step 2.

### Input handling and concurrency

`src/shared/prompt/confirm.ts` provides a streaming reader through `promptLine`
and `canReadPipedStdin`. The old non-TTY reader served lines only after stdin
closed, which meant a driver answering several prompts in turn could wait
forever for EOF. Provider abort signals reach `promptLine`: an active terminal
reader closes, a piped-input waiter detaches, and a request cancelled while
waiting in the prompt queue denies without drawing a stale menu.

`ParallelRunner.ts:273`, `ArpeggioRunner.ts:375`, and
`TeamLeaderRunner.ts:1403` can run substeps simultaneously in one process
against one stdin, so prompts are serialized through a promise queue.

`resolveInteractiveChannels` (`src/features/tasks/execute/fork/humanGate.ts`,
called from `workflowExecutionBootstrap.ts`) computes `interactivePermissionPrompt` as
`canPromptForUserInput() || canReadPipedStdin()`. Unlike a human gate this is
not something a workflow declares, because any step can hit a permission
request. With neither a terminal nor a pipe the handler is left undefined and
the provider keeps deciding alone, which is the correct headless behavior.

### Provider support

Measured in real `takt run` executions:

| Provider | Blocked tool | Asked? |
| --- | --- | --- |
| `claude-sdk` | allowed after a number was typed | yes, mid-turn |
| `antigravity` | allowed after a number was typed | yes, at the turn boundary |
| `codex` | `Read-only file system` | no — the sandbox decided |

Only `claude-sdk` can ask *during* a turn, because only its CLI speaks a
request/response control protocol over stdin. Antigravity's headless input
stream accepts queued user turns, not mid-turn permission responses, so TAKT
bridges the gap by resuming the conversation after the denial; the
[Antigravity provider specification](antigravity-provider.md) describes that
loop and what it costs.

Claude Code auto-approves read-only Bash, so `git log -n 1 --oneline` is not a
reliable permission probe. `mkdir` is a reliable probe.

Tests cover menu rendering and selection, the four scoped labels and the
generic fallback, the dropped allow-once row and its index shift, the
claude-sdk turn latch and that `cliArg` is not forwarded, malformed answers,
terminal sanitization, abort-signal forwarding, and already-aborted prompts.

## Provider router

The unimplemented quota-aware router is documented in the
[fork-provider-router proposal](fork-provider-router.md). It adds a
command-backed routing input to `auto_routing.router`, so it belongs to the
provider extension area rather than the command surface.
