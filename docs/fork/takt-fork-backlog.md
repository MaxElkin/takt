# TAKT fork backlog

Part of the [TAKT fork overview](takt-fork-spec.md). Written 2026-09-08.

Ordered by what is worth doing first, not by size. Only fork work is listed:
anything that belongs to a repository using the fork — its own configuration,
workflows, or sandbox policy — is tracked by that repository.

## The two menu rows that are specified but absent

Both are named in the
[capability table](takt-fork-providers.md#what-each-provider-actually-offers).

- **Sandboxed grants for `claude-sdk`.** `ClaudeSandboxShape` exposes only
  `allow_unsandboxed_commands` and `excluded_commands`; the SDK's `enabled` and
  `autoAllowBashIfSandboxed` are reachable only from `.claude/settings.json`,
  because TAKT passes `settingSources: ['project']`. Adding the two schema
  fields and a passthrough in `src/infra/providers/claude.ts` is the whole job,
  and it is what makes "sandboxed - this turn" honest on claude rather than
  missing.
- **Rest-of-run grants for `antigravity`.** Needs a session store outliving one
  provider call: crossing step boundaries, inherited by `workflow_call`, dying
  with the process, never persisted to `tasks.yaml`, and clamped by the step's
  own `permissionMode`. Larger than the above, and worth doing only if turn
  scope proves too chatty in practice.

## Antigravity, past proof of concept

The provider's own list is in the
[Antigravity provider specification](antigravity-provider.md#todo). What is
left, in order:

- **Keep the repository's `ask` and `deny` grants when the gate comes down.**
  Unattended `edit`, an approved resume, and `full` pass
  `--dangerously-skip-permissions`, which skips every grant. A repository that
  asks for `git push` through its grants gets no prompt there, and the sandbox
  does not stop network writes. Candidates: run unattended `edit` without the
  flag and report grant denials as step errors, or resume an approved turn
  with only the approved command granted, if `agy` can take a per-call grant.
  The [mode table](antigravity-provider.md#--sandbox-alone-does-not-help-with-the-bypass-it-does)
  records the current mapping.
- **Coverage against a real binary.** Everything is verified against a mocked
  child process, so the argv mapping and the resume loop are checked only by
  hand — including the fix where an approved resume used to drop `--sandbox`,
  and the two deadline fixes.
- **Tool allowlist, MCP, images.** Blocked on `agy` itself rather than on TAKT.
  There is nothing to build until the CLI grows `--allowed-tools`, a per-call
  MCP config, and image input.

## Unimplemented proposals

- **Quota-aware provider router.** Specified in the
  [fork-provider-router proposal](fork-provider-router.md); nothing is
  implemented and no command backend exists.
