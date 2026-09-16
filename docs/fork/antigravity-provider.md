# Antigravity (`agy`) provider for TAKT

Status: **working**, past proof of concept. It reads and answers correctly
against a real repository, classifies its own failures, and can put a denied
tool call in front of the human. The gaps that still keep it from production
use are listed under TODO.

Written 2026-09-07 against `agy` 1.1.27 and TAKT 0.64.1. Revised the same
day after the permission work below.

Part of the fork described in the [provider extensions spec](takt-fork-providers.md).
The [fork overview](takt-fork-spec.md) covers the other extension areas and
shared verification state.

## Why it exists

To find out whether TAKT could drive a CLI it was not designed for. It can: the
provider seam is a single `call(prompt, options) -> AgentResponse`, and `agy`
offers everything that needs — a non-interactive turn, machine-readable output,
schema-constrained results, and resumable conversations.

## What was built

| File | Lines | Role |
| --- | --- | --- |
| `src/infra/antigravity/types.ts` | 18 | Call options |
| `src/infra/antigravity/project.ts` | ~75 | Resolve the agy project from `cwd` |
| `src/infra/antigravity/stream.ts` | ~250 | NDJSON parsing, usage mapping, tool calls & denied actions |
| `src/infra/antigravity/client.ts` | ~530 | argv, spawn, aborts, taxonomy, permission prompt & resumption |
| `src/infra/providers/antigravity.ts` | 75 | `Provider` implementation |

Registration cost seven lines across six files: `PROVIDER_TYPES`
(`src/shared/types/provider.ts`), the registry (`src/infra/providers/index.ts`),
`ProviderProfileName` (`src/core/models/provider-profiles.ts`),
`model-candidates.ts`, `permission-profile-resolution.ts`, and one `case` in
`src/infra/providers/mcp/index.ts` routing it to the unsupported adapter.

Six further files matched a grep for an existing provider name but needed
nothing — they do not switch exhaustively over the union. `tsc` identifies the
ones that matter in one run; grep over-counts.

## The `agy` stream format

`--output-format stream-json` emits NDJSON discriminated on `event`, not on
Anthropic's `type`. Three kinds matter:

```json
{"event":"init","conversation_id":"…","init":{"model":"…","cwd":"…","tools":[…]}}
{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"ok\n","usage":{…}}}
{"event":"result","result":{"conversation_id":"…","status":"SUCCESS","response":"…","num_turns":1,"usage":{…}}}
```

None of Anthropic's vocabulary appears — no `content_block_delta`,
`thinking_delta`, `tool_use` or `subtype`. Everything needed arrives in the
single `result` event, which makes the parser about half the size of the
Anthropic one it was adapted from.

`step_update` also reports tool calls (`step_type: "tool"`, plus `tool_name`
and a `state` of `ACTIVE` / `DONE` / `ERROR`). The provider ignores these; they
are the obvious source for activity reporting later.

The `result` event carries one more field the provider currently drops, and it
matters for the permission work below: `denied_actions`.

```json
"denied_actions": [{"action": "command", "display_name": "RunCommand"}]
```

It is structured, it names the action, and it is present exactly when a tool
was refused. The prose notice printed alongside it names no command at all —
it emits a literal `command(<target>)` placeholder — so this array is the only
machine-readable account of what was denied.

## Verified behaviour

**Structured output.** `--json-schema <path|string>` returns a parsed,
schema-filtered object in `result.structured_output`. The model emitted two
extra keys in one probe; `agy` stripped them before returning. This maps
straight onto `AgentResponse.structuredOutput` with no text parsing, which is
stronger than the codex path, where TAKT must locate JSON inside prose.

**Session resume.** `agy` cannot be told which conversation id to create, only
which to resume. The provider captures `conversation_id` from the `init` event
and passes it back as `--conversation`. Verified across two calls: same id,
and the second turn recalled a number stated in the first. TAKT's `sessionId`
model needed no change, so `session_key` works.

**Usage.** `result.usage` maps cleanly onto `ProviderUsageSnapshot`:
`input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`.

## The project-binding trap

The first run against a real workflow failed with "Phase 1 returned empty
output" three times over. The cause was not permissions in the ordinary sense.

`agy` binds each run to a project. `~/.gemini/config/projects/` holds one JSON
per project; a repository entry carries its project name, a
`gitFolder.folderUri`, and the user's accumulated `permissionGrants`.
Alongside those entries sits `default-cli-project.json`, which has no resources
at all.

A headless run started without `--project` lands on that empty default. It
trusts no workspace and carries no grants, so the agent is denied even reading
the files it was pointed at:

```
view_file {"AbsolutePath": "/path/to/project/README.md"}   ERROR
  permission check failed for read_file "…/README.md": user denied permission
jetski: no output produced — a tool required the "read_file" permission that
headless mode cannot prompt for, so it was auto-denied. …
RESULT status=SUCCESS response='' turns=1
```

The same prompt with the matching `--project` reads the repository and answers.
So the provider resolves the project from the working directory
(`src/infra/antigravity/project.ts`): scan the project JSONs, take the one whose
`gitFolder.folderUri` contains `cwd`, most specific folder wins.
`options.project` overrides it, and an unmatched directory passes no flag at
all — which is the old behaviour, and correctly so, since there is no project
to name.

Note the failure shape, which is the reason the diagnostic fix below mattered:
`status: "SUCCESS"`, empty `response`, exit code 0, and the explanation printed
as **prose on stdout** rather than as JSON or on stderr.

### What still needs approval

Reading is not permission-gated once the project is bound. Shell commands are.
Headless runs honour the harness's grants; they simply cannot prompt for
anything missing.

One sharp edge: matching is by prefix over the whole command line, not per
program, so a compound line may fail even when one of its parts is allowed.
With `command(ls)` granted, `pwd && ls -la` is still denied — the line begins
with `pwd`. Pipes have the same effect: `echo hi | tee f` is denied under
`command(tee)`.

Grants live in two places. `userSettings.globalPermissionGrants` in
`~/.gemini/config/config.json` applies everywhere; each project JSON under
`~/.gemini/config/projects/` carries its own `permissionGrants.permissionGrants`.
Both hold `allow`, `ask` and `deny` lists, in the forms `command(x)`,
`unsandboxed(x)`, `write_file(/path)`, `read_file(/path)`, `read_url(x)` and
`mcp(server/tool)`. A command runs sandboxed unless the model requests the
sandbox bypass for it; `unsandboxed(x)` lifts the prompt for that request, and
`command(x)` in `allow` does not. Print mode reads the grants and never writes
them, which is the correct division: grants belong to the harness that owns
them.

### `agy` cannot ask, by design

This is the finding that matters most for using `agy` under TAKT, and it is
not a gap to be closed on TAKT's side.

TAKT gained a permission prompt (`src/features/tasks/execute/permissionHandler.ts`):
a provider that raises a permission request gets a numbered menu on the
terminal, answerable from a TTY or from a pipe, so an agent driving `takt` can
reply too. The `PermissionHandler` seam it fills was already plumbed through
the engine and is consumed by `claude-sdk`, `claude-terminal` and
`deepseek-harness`. Its menu vocabulary is specified in the
[provider extensions spec](takt-fork-providers.md#permission-prompt).

`agy` reaches none of it. Its own changelog records the current behaviour: a
headless `-p` run used to hang or silently auto-approve, and now soft-denies
instead, printing a stderr notice naming the allow-rule that would permit the
tool. The binary carries both notices —

- one naming a fix (`Add an allow-rule under permissions.allow in settings.json`),
- one saying no rule will help (`Settings allow-rules do not apply; re-run with
  --dangerously-skip-permissions to auto-approve all tools`),

alongside internal strings like `headless soft-deny tool confirmation` and
`print-mode soft-deny failed for %s step %d`. Its `ask_permission` capability
sits behind a sidecar flag, `allows_user_interactions`, which headless runs do
not set. So there is no request for TAKT to answer: the denial happens inside
`agy` before anything crosses the wire.

Measured against the other two providers in a real `takt run`:

| Provider | Blocked tool | Asked? |
| --- | --- | --- |
| `claude-sdk` | allowed after a number was typed | yes, mid-turn |
| `codex` | `Read-only file system` | no — the OS sandbox decided |
| `antigravity` | allowed after a number was typed | yes, but only at the turn boundary |

`codex` cannot ask either, but it fails honestly and locally: a sandbox
violation surfaces as a kernel error.
`agy`'s failure is the least legible of the three — a soft-denied tool leaves
`status: "SUCCESS"` with an empty response, which is why the diagnostic fix
below was needed before any of this could be seen at all.

So `agy` does now reach the human, but by a route the other two do not need:
TAKT asks *after* the turn died and resumes a new one. What follows is that
loop and what it costs.

TAKT should not write the grant files — grants belong to the harness that owns
them, exactly as `claude-sdk`'s chosen grants are persisted by Claude's own
settings and never by TAKT.

### Why `claude-sdk` can ask and `agy` cannot

The difference is the channel, not the wiring. The Claude Agent SDK spawns its
CLI with `--output-format stream-json --verbose --input-format stream-json`,
and over that stdin the CLI sends a `control_request` of subtype
`can_use_tool` carrying `permission_suggestions`; the parent answers with a
`control_response`. `options-builder.ts:65` sets that `canUseTool` callback
from `onPermissionRequest`, and the suggestions TAKT renders as numbered
choices are the ones arriving on the request.

`agy` has an input channel too — `--input-format stream-json` — but its own
help describes it as reading "one NDJSON message per line from stdin and runs a
turn for each". It is a queue of prompts, not a request/response protocol: the
binary handles `user` messages and answers anything else with `stream input
message event %q is not supported yet`. Same transport shape, different
semantics. One CLI can ask a question mid-turn; the other can only be handed
the next turn.

TAKT bridges this difference at the turn boundary rather than inside the turn.
The denied turn is already dead when TAKT sees it; what TAKT does is read
`result.denied_actions`, reconstruct the gated tool, ask the human, and then
start a **fresh turn** on the same `conversation_id`:

- If allowed: TAKT resumes via `--conversation <conversationId>` with the grant
  gate lifted, letting the approved action execute.
- If denied: TAKT resumes with the same conversation, telling the agent the tool
  call was denied and carrying the user's message or reason. The agent adapts
  and continues, so the workflow does not fail.
- If explicitly aborted (`interrupt: true` or `Ctrl+C`): TAKT halts the run with
  `EXTERNAL_ABORT`.

What the human sees is therefore three rows, not four:

```text
[WARN] run_command needs permission
[INFO] mkdir -p /tmp/takt-perm-probe-dir
[INFO]   1. Allow all commands - sandboxed - this turn
[INFO]   2. Allow all commands - NOT sandboxed - this turn
[INFO]   3. Deny
Allow run_command? Enter choice number, or a reason to deny:
```

The provider sets `allowOnce: false` on the request. There is no pending call
to release, so a bare allow could only do what row 1 already does, and offering
both put two identical choices on screen. It offers no `addRules` either: `agy`
cannot scope a grant to one tool, and an earlier version rendered that choice
and then silently dropped it.

Row 2 is the only one that drops `--sandbox`; the client detects it by looking
for `bypassPermissions` in `updatedPermissions`, and anything else — row 1, or
a bare allow from some other caller — keeps containment and lifts only the
grant gate.

Two properties of that loop are worth stating plainly, because neither is
visible from the prompt the human answers.

**It costs a whole turn per denial.** Nothing was suspended waiting for an
answer; the resumed turn re-reads its context and re-reasons from the top.
`MAX_PERMISSION_RESUME_DEPTH = 3` caps how many times one call may go round,
after which the denial is reported as an error instead of being asked about
again.

**The grant is turn-wide, not action-wide.** `agy` has no way to approve a
single pending call — the call is already gone — so lifting the gate lifts it
for everything the resumed turn goes on to do. The sandbox is what bounds that,
which is why an approved resume keeps `--sandbox` and lifts only the gate
(`approvalGranted` in `mapToAntigravityPermissionArgs`). An earlier version
resumed with `permissionMode: 'full'` instead, which dropped the sandbox as
well: approving one `mkdir` bought an uncontained turn, and made the supervised
path *less* contained than the unattended one. A denial resets the flag, so the
gate is back for the rest of the chain.

Worth noting for any future request to Google: `ask_permission` and
`ask_custom_permission` are both in the 57-tool list `init` reports **in
headless mode**. The model has the tool; the sidecar flag
`allows_user_interactions` is what turns calling it into a denial. Exposing
that on the print-mode wire is a smaller change than adding a protocol.

### `--sandbox` alone does not help; with the bypass it does

Probed directly against `agy` 1.1.27 with `mkdir -p ~/takt-perm-probe-dir`,
a path outside the workspace:

| Flags | Outcome |
| --- | --- |
| *(none)* | `run_command` → `ERROR`, empty response, turn killed |
| `--sandbox` | identical — the permission layer denies before the sandbox is consulted |
| `--sandbox --dangerously-skip-permissions` | `run_command` → `DONE`; the sandbox refuses the write at the filesystem and the model reads the error, reports it, and continues |

The third row is exactly what `codex` does under `workspace-write`, and it is
the shape that makes a denial useful: an ordinary tool error the model can
react to, rather than one delivered above its head that takes the turn with it.

So `PermissionMode` maps onto `agy` argv as follows:

| mode | agy (interactive / `onPermissionRequest`) | agy (unattended / headless) | after an approved resume |
| --- | --- | --- | --- |
| `readonly` | `--sandbox --mode plan` | `--sandbox --mode plan` | unchanged |
| `edit` | `--sandbox` | `--sandbox --dangerously-skip-permissions` | `--sandbox --dangerously-skip-permissions` |
| `full` | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` | unchanged |

A step that declares no mode at all normally passes no permission flags and
takes `agy`'s defaults; an approved resume of such a step maps as `edit`, since
the gate it just answered has to come down and the sandbox is what replaces it.

`readonly` runs with `--sandbox --mode plan`. Plan mode suppresses interactive
permission prompting by operating as a non-editing planner where unpermitted writes
are blocked at the sandbox level (`Read-only file system`), ensuring read-only steps
never prompt the user for editing.

In `edit` mode, when an interactive permission handler is present, `agy` runs under
`--sandbox` without pre-bypassing permissions. Ungranted commands trigger `agy`'s grant
gate, emitting `denied_actions` and invoking TAKT's interactive permission prompt
(`onPermissionRequest`), matching `claude-sdk`'s `acceptEdits` behavior.
Without an interactive handler, `edit` falls back to `--dangerously-skip-permissions`
paired with `--sandbox` so unattended runs rely on sandbox containment rather than
failing immediately on un-pregranted commands (matching Codex's `workspace-write`).

`--dangerously-skip-permissions` skips every grant, not only the missing ones:
`ask` and `deny` grants stop applying too. So under the unattended `edit` row,
an approved resume, and `full`, a repository that asks for `git push` or
`rm -rf` through its grants gets no prompt, and only the sandbox bounds the
command. A push goes over the network, which the sandbox does not stop. This
is listed in the [fork backlog](takt-fork-backlog.md#antigravity-past-proof-of-concept).

## Deadlines

TAKT's step deadline is an *inactivity* deadline, not a wall clock. It arms a
timer at `inactivityTimeoutMs` and re-arms it on every activity signal;
`STALE_IN_FLIGHT_TOOL_FACTOR = 6` extends the window to six times that while a
tool is known to be running, measured from when that tool started. Both inputs
were missing for `agy`, in opposite directions.

**`agy` was cutting turns short.** Its print mode has its own deadline,
`--print-timeout`, defaulting to **5 minutes** — twelve times shorter than
TAKT's own default of an hour. The provider never set it, and only matched the
string `print-timeout` in the error text afterwards to classify the failure as
`STREAM_IDLE_TIMEOUT`. So the effective budget was agy's, silently. The
provider now passes `--print-timeout` derived from the step's call timeout and
multiplied by the in-flight factor, which makes TAKT's deadline the one that
fires and agy's a backstop. `guards.callTimeoutMs` under
`provider_options.antigravity` configures it, like every other provider; the
same value feeds TAKT's own deadline, which had no `antigravity` branch and so
always took the default.

**TAKT could not see a tool running.** The provider emitted only
`{type: 'text'}` stream events, so text deltas re-armed the deadline but no
tool was ever registered as in flight — a long `run_command` was judged by the
plain window measured from the last delta, never earning the 6× extension.
`agy` reports tools as ordinary step updates (`step_type: "tool"`, a `state` of
`ACTIVE`/`DONE`/`ERROR`, and a `step_index` stable across that tool's updates),
so the parser lifts them out and the provider forwards them as `tool_use` and
`tool_result`. The engine already turns those into `tool_started` /
`tool_finished`, so nothing above the provider changed.

Two shapes in that mapping are deliberate. A tool emits several updates while
it runs, so each transition is reported once — a repeated `ACTIVE` is not a
second call. And a tool that only ever reports a terminal state has its start
synthesised first, because an end with no beginning leaves the deadline holding
an unmatched pair.

## Fixed

- **Temp schema file deleted before the child read it.** `withSchemaFile`
  returned the promise from inside `try/finally`, so the `finally` ran when the
  promise was handed back rather than when it settled. Needs `return await`.
- **`onStream` payload shape** is `{ type, data: { text } }`, not
  `{ type, text }`.
- **Diagnostics were discarded.** Non-JSON stdout lines are now collected and
  reported as the error text, and a `SUCCESS` result with an empty response is
  reported as an error carrying them rather than as `done`. Without this the
  project-binding failure above surfaced only as "empty output".
- **No project binding.** `--project` is now resolved from `cwd`; see above.
- **No failure taxonomy.** Every outcome but `SUCCESS` arrived as a generic
  error, so TAKT's retry, backoff and fallback routing had nothing to act on.
  `agy`'s own signals are now mapped: `result.denied_actions` (which
  `printmode.buildResultOutput` populates as
  `[{"action": "...", "display_name": "..."}]`) drives the permission loop
  instead of scraping prose; gRPC `RESOURCE_EXHAUSTED`, HTTP `429`, and the
  `quota exceeded` / `out of credits` / `failed to refresh G1 credits` strings
  become `status: 'rate_limited'` with `rateLimitInfo`, which activates
  provider fallback; `--print-timeout` expiry and `DEADLINE_EXCEEDED` become
  `STREAM_IDLE_TIMEOUT`, and an abort is split into `EXTERNAL_ABORT` or
  `PART_TIMEOUT` by `classifyAbortSignalReason`; a missing `result` event at
  exit code 0 is `PROVIDER_STREAM_PARSE_ERROR`, while a non-zero exit or an
  explicit `ERROR` status is `PROVIDER_ERROR`.

## TODO

Roughly in the order they would block real use.

1. **Tool allowlist.** `agy` has no `--allowed-tools`. Until that changes the
   provider must stay out of `ALLOWED_TOOLS_PROVIDERS`, and `edit: false` is a
   request in the prompt rather than an enforced restriction. `--sandbox` and
   `--mode plan` are the only coarse substitutes. The harness's grants
   restrict commands, file writes and URLs, but not per step.
2. **Coverage beyond unit tests.** The parser and client suites
   (`src/__tests__/antigravity-stream.test.ts`,
   `src/__tests__/antigravity-client.test.ts`) cover the stream shapes, the
   failure taxonomy and the permission loop against a mocked child process.
   Nothing exercises the provider against a real `agy` binary, so the argv
   mapping and the resume loop are verified only by hand.
3. **MCP.** `agy` registers servers through a persistent `mcp` subcommand;
   TAKT passes a per-call `--mcp-config` file. The models do not line up.
   Currently routed to the unsupported adapter, which is the honest answer.
4. **Images.** `supportsNativeImageInput = false`. Not investigated.
5. **Model list.** `agy models` offers Gemini 3.x, `claude-sonnet-4-6`,
   `claude-opus-4-6-thinking` and `gpt-oss-120b`. This is a route to Gemini,
   not to better Claude access — `claude-sdk` already reaches newer models.

## Estimating note

This was first estimated at a day and took roughly two hours. The estimate came
from grepping for an existing provider name and assuming each of the twelve
matches needed work; half needed nothing, and the compiler would have said so
immediately. The day was the right figure for a production provider — items 1
through 3 above are the difference — but the wrong one for finding out whether
the thing works at all.
