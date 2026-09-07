# The TAKT fork

Written 2026-09-07, revised 2026-09-08 after the permission-scope and
resource-sync work.

## What is in it

The fork is now organized by extension area:

| Area | Contents | Specification |
| --- | --- | --- |
| Workflows | `requires_approval`, `user_prompt_field`, and workflow-derived interactive input | [Workflow extensions](takt-fork-workflows.md) |
| Commands | Named `takt resume` / `takt restart` | [Command extensions](takt-fork-commands.md) |
| Providers | Antigravity (`agy`), permission prompt, and provider router | [Provider extensions](takt-fork-providers.md) |

Open work across all three areas is collected in the
[fork backlog](takt-fork-backlog.md).

The [fork-provider-router proposal](fork-provider-router.md) is an unimplemented
provider extension. The detailed [Antigravity provider specification](antigravity-provider.md)
contains the provider's protocol notes and TODO list.

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

## Shared status

The existing implementation has passed `tsc`, type-contracts, ESLint, diff
checks, `npm run build`, the unit gate (405 files and 6,255 tests) and the
light integration gate (155 files and 2,292 tests). E2E gates have not been
run.
