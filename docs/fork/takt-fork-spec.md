# The TAKT fork

Written 2026-09-07, revised 2026-09-08 after the permission-scope and
resource-sync work.

## What is in it

The fork is now organized by extension area:

| Area | Contents | Specification |
| --- | --- | --- |
| Workflows | `requires_approval`, `user_prompt_field`, and workflow-derived interactive input | [Workflow extensions](takt-fork-workflows.md) |
| Resource loading | Namespaced project workflows, schemas, and workflow-wide rules, including safe project-internal category symlinks | [Project resource namespaces](#project-resource-namespaces) |
| Commands | The `takt task` group: `add`, `list`, `tree`, `instruction`, `resume`, `restart`, `rewind`, `delete`, `config`, `prune`, the `{task_artifacts_dir}` placeholder and `current_task` it configures, and the blank-order task prompt; plus `takt workflow tree` on upstream's workflow group | [Command extensions](takt-fork-commands.md) |
| Providers | Antigravity (`agy`), permission prompt, and provider router | [Provider extensions](takt-fork-providers.md) |
| Logging | Duplicate-free `phase_start` prompt fields | [Session log fields](#session-log-fields) |
| Run storage | Task-stamped runs, bundle pruning, delete-with-runs | [Run directory lifecycle](#run-directory-lifecycle) |

Open work across all three areas is collected in the
[fork backlog](takt-fork-backlog.md).

The [fork-provider-router proposal](fork-provider-router.md) is an unimplemented
provider extension. The detailed [Antigravity provider specification](antigravity-provider.md)
contains the provider's protocol notes and TODO list.

## Where fork code goes

To keep rebases onto upstream cheap, new fork code lives in files upstream does
not have:

- CLI registration in `src/app/cli/fork/`, loaded by one import in
  `src/app/cli/index.ts`.
- Feature code in a `fork/` folder next to the upstream feature it extends,
  such as `src/features/tasks/fork/`.
- Tests in `src/__tests__/fork-*.test.ts`.

An upstream file is edited only for a one-line hook, a small export or option
it cannot do without, or an entry in a shared list (`tsconfig.tests.json`,
`scripts/test-classification.mjs`). Each such edit is named in the area's
specification. A private upstream helper a fork file needs is exposed by a
hook at the end of its file (`// Fork hook: ...` followed by `export { ... };`),
so the function bodies stay untouched. Upstream logic that cannot be exposed
that way is copied rather than refactored, with a note to keep it in step.

The `takt task` group (including `resume` and `restart`), the approval gate, human-gate discovery,
and the turn-scoped permission callback follow this layout. Older fork-only
test files (`restart-task`, `workflow-human-gate`,
`permissionHandler`, `antigravity-*`, `prompt-line-abort`) keep their names.
Some earlier work still edits upstream files directly: Antigravity registration and schema entries, the
`slug` option on task files, and small edits listed in each area's
specification.

## Verifying a change

The full command table and the repository's own conventions are in
[`CLAUDE.md`](../../CLAUDE.md); `AGENTS.md` and `CONTRIBUTING.md` carry the house
rules. A fork change is gated the same way any change is:

```bash
npm run lint && npm test && npm run test:it && npm run build
```

Three things about this repository catch out a first fork change, each because
it fails quietly rather than loudly:

- **The suite is sharded.** `npx vitest run <file>` on a file outside the
  default shard prints "No test files found", which reads as a missing test
  rather than a mis-run command. Route a single file with `npm test -- <file>`,
  which picks the right unit, light-IT or heavy-IT runner for it.
- **Vitest strips types, so a test is type-checked only if
  `tsconfig.tests.json` lists it.** A new `fork-*.test.ts` left off that list
  passes with type errors still in it. Adding the entry is part of writing the
  test, not a follow-up.
- **`npm run test:it` and the heavier gates need real filesystem access**, so a
  sandboxed shell has to be told to allow them.

Gate counts are deliberately not recorded here. They change with every test
added, and a number that drifts is worse than no number — run the gate.

## Project resource namespaces

Project resources use one category namespace across the three workflow-facing
roots:

| Root | Namespaced reference | Resolved path |
| --- | --- | --- |
| `.takt/workflows/` | `syncthing/consult/consult` | `.takt/workflows/syncthing/consult/consult.yaml` |
| `.takt/schemas/` | `pf/consult-review` | `.takt/schemas/pf/consult-review.json` |
| `.takt/rules/` | `syncthing/takt-step-context` | `.takt/rules/syncthing/takt-step-context.md` |

Each root must be a real directory. A project category directory may be a
symlink to a target inside the project, which lets a repository keep authored
workflows, schemas, and rules beside the project documentation while retaining
short names in task records and YAML. Lookup checks both the lexical path and
the resolved target; links that escape the project are rejected. The same
contract is used by runtime loading and `takt workflow doctor`.

Workflow-wide rules retain the older project lookup layer at
`.takt/workflows/rules/` for compatibility. It is checked before the shared
`.takt/rules/` root; new rules intended for reuse across workflows belong in the
latter.

## Project resource sync

`SYNCED_TAKT_RESOURCES` in `src/infra/task/projectLocalTaktSync.ts` decides
which project-local `.takt` entries a worktree run sees from the working tree
rather than from the last commit. Upstream listed five: `config.yaml`,
`workflows`, `facets`, `steps`, `quality-gates`.

The list was incomplete against what a workflow can reference at load time.
`schemas` is the clearest case — `structured_output.schema_ref` resolves to
`.takt/schemas/<name>.json`, so an uncommitted schema failed to resolve in a
worktree, and an uncommitted *edit* to a committed one was silently ignored
while the workflow referencing it synced live. The fork adds `runtime.yaml`,
`schemas`, `companions`, `facet-pools` and `provider-options`.

`exec/presets` and `takt-repertoire.yaml` are deliberately left off: they are
read by their own commands, not during a run.

The shipped `builtins/project/dotgitignore` has the matching gap — it
allowlists `workflows`, `steps` and five facet kinds, so the same authored
paths are untracked by default and never reach a clone either. That template is
unchanged here; a project wanting them versioned extends its own
`.takt/.gitignore`.

## Session log fields

A `phase_start` record in `.takt/runs/<slug>/logs/*.jsonl` carried the step's
prompt three times: `instruction` (what `InstructionBuilder` composed),
`userInstruction` (what the provider was called with) and `systemPrompt`. For a
plain agent phase the first two are the same string, and a step declaring no
persona resolves an empty system prompt, so a ~4.5 KB instruction was written
twice per phase next to a field holding nothing.

`phasePromptFields` in `src/features/tasks/execute/fork/phasePromptFields.ts`
writes only the fields that carry information: `instruction` when it differs
from what was dispatched, `systemPrompt` when it is not empty, and
`userInstruction` always. The two prompts differ exactly where the distinction
matters — the report and judge phases build their own prompt, empty-response
recovery retries with a modified one, and `TeamLeaderRunner` and
`ArpeggioRunner` synthesize sub-step prompts.

Nothing downstream loses anything: `traceReportParser` already resolves
`instruction ?? userInstruction ?? prompt?.userInstruction` and the mirror of
that for `userInstruction`, and the NDJSON validator in `infra/fs/session.ts`
requires none of the three on a phase record.

The prompt log (`prompts.jsonl`) duplicates the same text again in its `prompt`
and `userInstruction` fields, but `PromptLogRecord` declares both as required
and the trace parser reads them, so that file is left alone.

Sites: one call replacing the three assignments in `buildPhaseStartRecord`
(`src/features/tasks/execute/sessionLoggerRecordFactory.ts`), with its import.
Test: `fork-phase-prompt-fields`.

## Run directory lifecycle

Every attempt at a task gets its own `.takt/runs/<slug>/`: a resume never
reuses the previous directory, it opens a new one and records its predecessor
in `source_run_slug`. Upstream never removes any of them - `takt purge` only
covers analytics events - so the directories accumulate one per attempt, each
carrying a `workflow-bundle/` that is a verbatim copy of the project's
workflows and facets (~3.5 MB here), rebuilt from scratch every run.

### Identifying a run's task

A run knows its task in two ways, because neither alone is enough:

- **The `task_dir` stamp.** `meta.json` gains `task_dir`, the queued task's
  `.takt/tasks/<slug>`. It is absent for a run with no queued task
  (interactive, `takt exec`) and for a task carrying its text as `content` or
  `content_file`.
- **The resume chain**, walked backwards through `source_run_slug`. This is
  the only route for runs written before the stamp existed, and the fallback
  for the taskless cases above.

A run whose `meta.json` is missing or corrupt is never claimed by either
route, and a run another task still points at is excluded, so a shared or
reused slug cannot be deleted out from under a live task.

`generateReportDir` slugifies the first 80 characters of the *prompt* a run
started with, which for a queued task is the pointer text from
`buildTaskInstruction` - so every queued task produces a directory named
`<timestamp>-implement-using-only-the-files-<suffix>`. That is cosmetic and
deliberately left alone; identification does not read the slug.

### Pruning superseded bundles

When a new run directory is reserved, `pruneSupersededRunBundles`
(`src/features/tasks/execute/fork/pruneSupersededRunBundles.ts`) walks the
chain behind it and deletes each ancestor's `workflow-bundle/`. Nothing reads
a superseded run's bundle: every bundle path derives from the current run's
`RunPaths`, and a resume touches its predecessor only through
`report-inheritance`, which copies out of `reports/`.

`meta.json`, `reports/`, `context/`, `logs/` and `trace.md` stay - that is the
record of what happened, and `meta.json` is what keeps the chain walkable.
Pruning is best-effort and never fails a run.

### Deleting a task

`takt task delete` now removes the task's runs and its task directory along
with the record. The confirmation names what goes, so the single yes/no
question stays the only prompt:

```text
Delete failed task "kek" and its 3 runs (216 KB) and its task directory?
```

Runs are resolved by both routes above; a partial identification is reported
and leaves the unidentified runs in place. A failure to delete a run or the
task directory is reported and sets a non-zero exit code, but does not undo
the record deletion.

Runs belonging to no task - interactive, `takt exec`, `debug-*`, and whatever
an earlier delete left behind - are never touched by that path. They are what
`takt task prune` collects: everything under `.takt/runs` and `.takt/tasks` no
record in `tasks.yaml` claims, behind the same single confirmation. A run whose
meta still says `running` is kept, since an interactive run in progress claims
no task and is not garbage. See
[`takt task prune`](takt-fork-commands.md#takt-task-prune).

Sites: `task_dir` threads from the task record through
`WorkflowTraceTaskMetadata` (which already carries `taskName` and `taskSlug`)
into `RunMetaManagerOptions`, `RunMeta` and both ends of the `meta.json`
round-trip in `core/workflow/run/run-meta.ts`; one call in
`workflowRunLifecycle.ts` prunes; `findTaskRunDirectories` in
`src/features/tasks/fork/taskRunDirectories.ts` does the identification for
`deleteNamedTask`, and `orphanDirectories.ts` inverts it for `pruneOrphans`.
Tests: `fork-task-run-directories`, `fork-prune-superseded-bundles`,
`fork-task-delete`, `fork-task-prune`.
