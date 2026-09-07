# TAKT fork command extensions

Part of the [TAKT fork overview](takt-fork-spec.md).

## Named `takt resume` and `takt restart`

The interactive `takt list` path already knew how to resume a failed task, but
doing so required selecting the task, choosing Retry, going through the retry
conversation, and then choosing immediate execution. The named commands expose
shorter paths when the task itself is still correct:

```bash
takt resume my-task
takt restart my-task
```

The name must exactly match a saved task. Shell quotes are needed only for a
name containing spaces or shell-special characters; ordinary generated task
names need no quotes.

| Command | Eligible status | Start position | Session state |
| --- | --- | --- | --- |
| `takt resume <task-name>` | `failed` | Saved checkpoint; recorded failed step when no valid checkpoint exists | Preserved |
| `takt restart <task-name>` | `failed`, `completed` | Root workflow's declared `initial_step` | Fresh |

For a root `initial_step` that calls a child workflow, restart follows the
child's declared `initial_step` as well; “first” means the configured entry
point, not necessarily the first step written in YAML. Both commands reuse the
task's existing worktree and execute immediately without opening the retry
conversation. A failed task's prior failure is appended to the retry note so
the resumed step can react to it. A completed task restarts without failure
feedback.

The existing no-argument `takt resume` remains unchanged: it opens the direct
run recovery menu. `takt restart` always requires a task name.

Sites: command registration in `src/app/cli/commands.ts`, exact-name/status
resolution in `src/features/tasks/restart/index.ts`, and execution through the
existing retry path in `src/features/tasks/list/taskRetryActions.ts`.

Tests cover both CLI routes, exact task selection and status checks, root
command registration, and initial-step restart paths including a nested
workflow call.
