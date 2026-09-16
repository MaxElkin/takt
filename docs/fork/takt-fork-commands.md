# TAKT fork command extensions

Part of the [TAKT fork overview](takt-fork-spec.md).

## `takt task resume` and `takt task restart`

The interactive `takt list` path already knew how to resume a failed task, but
doing so required selecting the task, choosing Retry, going through the retry
conversation, and then choosing immediate execution. The named commands expose
shorter paths when the task itself is still correct:

```bash
takt task resume --name my-task
takt task restart --name my-task
```

The name must exactly match a saved task. Shell quotes are needed only for a
name containing spaces or shell-special characters; ordinary generated task
names need no quotes.

| Command | Eligible status | Start position | Session state |
| --- | --- | --- | --- |
| `takt task resume --name <name>\|--current` | `failed`, `pending` | Saved checkpoint; recorded failed step when no valid checkpoint exists | Preserved |
| `takt task restart --name <name>\|--current` | `failed`, `completed`, `pending` | Root workflow's declared `initial_step` | Fresh |

For a root `initial_step` that calls a child workflow, restart follows the
child's declared `initial_step` as well; “first” means the configured entry
point, not necessarily the first step written in YAML. Both commands reuse the
task's existing worktree and execute immediately without opening the retry
conversation. A failed task's prior failure is appended to the retry note so
the resumed step can react to it. A completed task restarts without failure
feedback.

A `pending` task has never run, so there is nothing to resume or restart from.
Both commands simply start it, which is the work `takt run` would do for the
whole queue, narrowed to one task by name. That is `startPendingTask`.

A task killed without a graceful shutdown - a second Ctrl+C, or a crash - stays
`running` with a dead `owner_pid`, and upstream only heals that inside
`takt run` and `takt watch`. Both commands therefore call
`failInterruptedRunningTasks` before they read the task list, so such a task
becomes `failed` and is resumable instead of being refused. A task a live
process still owns stays `running` and is refused.

Upstream's retry path requires a `worktree_path` and throws without one,
because the interactive flow it serves is worktree-based. A `worktree: false`
task - what `takt task add` creates - runs in the project directory itself, so
`resolveExecutionDir` uses the project directory for it and checks a reusable
worktree only for a task that has one.

Both live in the `takt task` group, so upstream `takt resume` is left exactly
as it is: it takes no argument and opens the direct run recovery menu. Naming
no task — neither `--name` nor [`--current`](#--current-task-and---current) —
prints an error and exits 1 before anything runs.

Sites: registration next to the other subcommands in
`src/app/cli/fork/taskCommands.ts`. Exact-name/status resolution is in
`src/features/tasks/restart/index.ts`, and `restartActions.ts` beside it runs
both commands through the retry helpers of `taskRetryActions.ts`, which exports
them from an end-of-file fork hook. `initialRestartPoint.ts` builds the restart
point from helpers exported the same way by `taskRetryStartPath.ts`.

Tests (`fork-task-commands`, `fork-cli-registration`, `restart-task`,
`fork-restart-actions`, `fork-initial-restart-point`) cover both CLI routes,
exact task selection, status checks and healing, pending starts, worktree-less
execution, command registration, and initial-step restart paths including a
nested workflow call.

## `takt task` command group

Upstream had no `task` command, so `takt task` fell through to the root
`[task]` argument and started a new task whose text was the word `task`. The
fork registers `task` as a command group. `takt task` and `takt task -h` print
its help, which lists only its subcommands — the implicit `help` subcommand is
disabled.

| Command | Behavior |
| --- | --- |
| `takt task add --name <name> --workflow <workflow>` | Queue a task without prompts |
| `takt task list` | Print a name, status and workflow table, marking the current task, without prompts |
| `takt task tree --name <name>\|--current [--full]` | Show where the task stands in its workflow, as a step tree |
| `takt task instruction --name <name>\|--current [--complete [result]]` | Print the Phase 1 prompt for the step the task stands on; with `--complete`, its rules and output contract instead, and with a result or a step name, move the task on |
| `takt task resume --name <name>` | Resume a failed task, or start a pending one ([above](#takt-task-resume-and-takt-task-restart)) |
| `takt task restart --name <name>` | Restart from the first step, or start a pending task ([above](#takt-task-resume-and-takt-task-restart)) |
| `takt task rewind --name <name>\|--current --step <step> [--workflow <workflow>]` | Move the task's current pointer to a selected authored step, without prompts |
| `takt task delete --name <name>\|--current` | Delete one task by exact name, after a yes/no confirmation |
| `takt task config [--tasks-artifacts-dir <path>] [--current-task <name>]` | Show or set the task-scoped project config keys |
| `takt task prune` | Delete every run and task directory no task accounts for, after a yes/no confirmation |

The group is for a caller that cannot answer a menu, such as an agent. `add`,
`list`, `tree`, `instruction`, `resume`, `restart`, `rewind` and `config` run without asking anything;
`delete` and `prune` ask only one yes/no question before they delete. A refusal prints an error and exits 1. The
top-level `takt add`, `takt list` and the rest stay unchanged for interactive
use. A task whose whole text is `task` must now be passed as `takt -t task`.

Every subcommand that takes `--name` accepts `--current` in its place, which
resolves through the `current_task` key — see
[`--current-task` and `--current`](#--current-task-and---current).

One fork command sits outside this group:
[`takt workflow tree --name <name> [--full]`](#takt-workflow-tree), which shows
a workflow's steps with no task involved and is appended to upstream's own
`takt workflow` group.

The group lives in fork-only files: `src/app/cli/fork/taskCommands.ts`
registers it, and the handlers are in `src/features/tasks/fork/`. `index.ts`
loads `src/app/cli/fork/index.js` right after upstream `commands.js`, so `task`
is the last command in `takt -h`. The same fork entry also rewrites the
`takt list` help text, which upstream describes as listing branches, in
`src/app/cli/fork/listCommandText.ts`.

### `takt task add`

`takt add` is built for a person at a terminal: it takes free task text, asks
for a workflow when none is given, asks about worktree, branch and PR, and has
a model summarize the text into the task name. `takt task add` is the
non-interactive counterpart for a caller that already knows what it wants:

- `--name` is the task name, used exactly. It is also the task text and the
  slug; nothing is summarized. No task text is accepted.
- `order.md` is written **empty**. The name is a label, not a specification —
  see "Blank orders and instruction precedence" below.
- `--workflow` must resolve to a workflow name or file; `-w` works too, since
  it is the same global option.
- The task is saved with `worktree: false`, and nothing is asked.
- A missing option, an unknown workflow, or a name already in `tasks.yaml`
  prints an error, saves nothing and exits 1. An existing name is refused
  rather than suffixed, because `resume`, `restart` and `delete` address tasks
  by exact name.

Sites: `addNamedTask` in `src/features/tasks/fork/addNamedTask.ts`; the
optional `slug` in upstream `SaveEnqueuedTaskFileOptions`, which
`saveEnqueuedTaskFile` uses instead of summarizing; the `orderContent` option
already on upstream `prepareTaskSpecDirectory`, which is what writes the empty
`order.md`.

#### Blank orders and instruction precedence

Every run opens with a task prompt that upstream builds unconditionally
(`buildTaskInstruction`, `src/infra/task/instruction.ts`):

```text
Implement using only the files in `.takt/runs/<slug>/context/task`.
Primary spec: `.takt/runs/<slug>/context/task/order.md`.
Use report files in Report Directory as primary execution history.
Do not rely on previous response or conversation summary.
```

It lands under `## User Request` in the phase-1 prompt, **above** the step's own
instruction under `## Work`, and nothing in the template states which governs.
Three things then stack against the workflow: the boilerplate is phrased as a
hard scope constraint ("using **only**", "**Primary** spec"), it is labelled as
the user's request while the step instruction reads as procedure, and no
precedence rule contradicts either. A model resolves that the obvious way.

For an implement-style workflow that is correct. For a task whose `order.md`
held nothing usable — `takt task add --name kek` used to write `kek` — it was a
category error: the `consult` workflow's `ask` step kept interrogating the spec
file ("the specification contains only 'kek'") instead of consulting the human,
and the `review` step disowned the consultation it was handed, because the
prompt's last line told it not to rely on the previous response.

So an empty order is treated as the **absence** of a request rather than an
empty one, and the prompt defers instead of pointing at a file:

```text
No task specification was supplied for this run.
The workflow step instructions below define the work in full; there is no spec
file to consult and nothing to implement from one.
Use report files in Report Directory as primary execution history.
```

Blank means empty or whitespace-only, so an order that is deleted down to a
newline behaves the same as one never written. An order with real content keeps
upstream's prompt unchanged.

Sites: `src/features/tasks/fork/taskPrompt.ts`; one upstream hook at the single
place that builds the prompt, `taskPrompt` in
`src/features/tasks/execute/taskSpecContext.ts`.
Tests: `src/__tests__/fork-blank-order-prompt.test.ts`,
`src/__tests__/fork-task-add.test.ts`.

### `takt task list`

Prints every task as a table with `NAME`, `STATUS` and `WORKFLOW` columns,
padded to the widest value, or `No tasks to list.`, and exits. A task without
a workflow shows `-`. Status uses the same labels as `takt list` (`pending`,
`running`, `completed`, `failed`, `exceeded`, `pr-failed`). It takes no
options.

The task [`--current`](#takt-task-config) resolves to carries `◀ current` — the
same marker [`takt task tree`](#takt-task-tree) puts on the current step, so one
glyph means the same thing throughout the group, and the list answers "which one
is that" without a second command:

```text
NAME   STATUS   WORKFLOW
kek    failed   consult/consult  ◀ current
other  pending  pipeline/full
```

A `current_task` naming no task marks nothing rather than complaining: the stale
key is reported when a command actually tries to act on it, and a list that
refused to print would be a poor way to find that out.

Site: `printTaskTable` in `src/features/tasks/fork/printTaskTable.ts`, using
`TASK_STATUS_BY_KIND`, which the fork exports from upstream
`src/features/tasks/list/taskStatusLabel.ts`, and `MARKER_CURRENT` from
`taskTree.ts`.
Tests: `src/__tests__/fork-task-list.test.ts`.

### `takt task tree`

Shows where a task stands inside its workflow. `--name` is required; `--full`
expands everything.

```text
Task:     refactor-auth
Workflow: pipeline/full
Status:   running

pipeline/full
├─ plan
├─ implement → impl/code-change
│  ├─ draft
│  ├─ verify → qa/gates
│  │  ├─ lint
│  │  ├─ test  ◀ current
│  │  └─ build
│  └─ summarize
└─ ship → release/publish
   └─ … 4 steps

--step "full/implement > code-change/verify > gates/test"
```

One rule produces that view: **the root workflow is listed in full, a
`workflow_call` expands only when the current step is inside it, and every
other call collapses to `… N steps`.** Everything asked of the display follows
from it — the current step, its siblings, its parent's siblings, and the whole
path down, each ancestor's siblings visible at its own level. `--full` drops
the rule and expands every call instead.

- The count is **recursive**: it is how many selectable steps are hidden in
  there, not how many the callee authors at its top level. A call that itself
  calls further contributes those steps too.
- The tree is upstream's restart tree, so it lists exactly the steps
  [`takt task rewind`](#takt-task-rewind) and the interactive picker accept -
  a step that is not a restart target appears in neither.
- The trailing line is the current step in the workflow-qualified form
  `rewind --step` accepts, so `tree` tells you what to type.
- The current pointer is read the way `takt task resume` reads it: a staged
  `restart_point` first, then run meta, then the record's `resume_point`. So
  the step marked current is the step a resume would continue from.
- A task that has never run has no pointer, and its root workflow's initial
  step is marked `◀ starts here`; a completed one is marked `◀ last`. A pointer
  resting on a `workflow_call` step itself marks the first step inside it.
- A call that cannot be resolved prints `… unavailable: <reason>` rather than
  dropping the branch, matching how the restart tree degrades.

Sites: `renderTaskTree` in `src/features/tasks/fork/taskTree.ts` (pure, takes
the pointer and returns the lines); `printTaskTree` in
`src/features/tasks/fork/printTaskTree.ts` (reads the task and its pointer).
Tests: `src/__tests__/fork-task-tree.test.ts`.

### `takt task instruction`

Prints the prompt the task's current step would be dispatched with, so the step
can be worked by an agent TAKT is not orchestrating:

```bash
takt task instruction --current > step.md
```

The step is the one [`takt task tree`](#takt-task-tree) marks — same pointer,
same restart tree, so the two never disagree about where a task stands.

**The text is built by `InstructionBuilder`, the engine's own Phase 1 builder**,
not by a second renderer beside it. That is the whole point: a separate
formatter would drift, and the value of this command is that what it prints is
what the step would have received. Upstream's `takt prompt` previews every step
of one workflow with a placeholder task; this prints exactly one step, reached
through subworkflows, with the task's own request.

Three things do not exist outside a run and are **absent by construction**: the
previous step's response, accumulated user inputs, and a retry note. Iteration
and step-iteration read `1` for the same reason. Nothing is invented to fill
them — a fabricated value would be read as fact by the agent the prompt is
handed to.

What *is* resolved for real:

- **The task's own request.** A blank `order.md` opens with the blank-order
  prompt ([above](#blank-orders-and-instruction-precedence)); a real one is
  pointed at `.takt/tasks/<slug>/order.md`, where the file actually is —
  not at the run-context copy upstream names, which exists only during a run.
- **Workflow-wide rules, inherited.** A nested step sees its own workflow's
  rules *and* every ancestor's, the way `mergeWorkflowWideRules` gives them to
  a called child at runtime.
- **`{task_artifacts_dir}`**, through the same resolver the execution boundary
  uses, so a step writing there names the directory it would name in a run.
- **The step's place in its own workflow** — the workflow structure block lists
  the callee's steps, not the root's, when the current step is nested.

Report paths name the task's most recent run. For a **nested** step they name
that run's reports root rather than the subworkflow's namespace, and the
command says so on stderr: the namespace is built from live iteration counters
that no reading of the record can reconstruct.

`stdout` carries the prompt and nothing else — every note goes to stderr — so
the command is safe to pipe.

#### `--complete`: finishing the step from outside

Bare, `--complete` prints **where the task stands and what the step owes**, and
nothing else — `## Execution Context` and `## Completion`, without the persona,
the policy or the work:

```bash
takt task instruction --current --complete
```

It is the other half of the pair. The prompt is for an agent about to do the
work; this is for one that has already done it and needs to know how to hand it
back. The execution context is cut from the same built prompt rather than
composed a second time.

`## Completion` holds `### Rules` — the step's `rules:` exactly as authored,
so the contract and the YAML cannot disagree — followed by the tag list Phase 3
puts in front of the judge, where the rules are label-based:

```yaml
rules:
  - condition: "when(structured.ask.outcome == \"hand_to_review\")"
    next: review
  - condition: "when(structured.ask.outcome == \"nothing_to_do\")"
    next: COMPLETE
    requires_approval: true
```

Rules that route on the step's own output are deterministic and the contract
says there is no tag to emit, rather than printing an empty criteria table.
`### Structured Output` follows with the step's schema verbatim, when it
declares one.

Given a result, the command reads it the way the engine reads a finished step's
response and **moves the task to the step it routes to**:

```bash
takt task instruction --current --complete '{"outcome":"hand_to_review"}'
takt task instruction --current --complete @result.json    # from a file
some-agent | takt task instruction --current --complete -  # from stdin
```

Nothing is printed but where the task moved. The routing is the engine's own:
`detectCandidateIndex` reads the tag, `RuleEvaluator` matches the rule,
`determineRuleTransition` names the next step, and `requeueTask` writes the
restart point **without running anything** — the task is left `pending` at its
new step, ready for `takt task resume` or another `instruction`.

**The result routes the task and is not kept.** It decides the next step and is
then discarded: it does not become the step's recorded output, and the next step
will not see it as a previous response or as `structured.<step>.*`. That matches
what TAKT already does on its own — `structuredOutputs` is built fresh per run
and never serialized, and a resumed run inherits `reports/` but not `context/`,
so neither crosses a resume boundary for the engine either. Recording it here
would mean inventing persistence the engine does not have, and a value that
survives outside a run but not inside one is worse than no value at all. Work
that has to carry across the boundary goes through a shared `session_key`, which
is what the bundled `consult` workflow does.

A `when(...)` rule is evaluated for real, not waved through: the submitted
result is filed under the step's own name, which is the key `StepExecutor`
files a structured output under, so a workflow routing on
`when(structured.<step>.outcome == "...")` — the common shape — resolves
exactly as it would in a run.

**A result may also be one of the steps the rules route to**, which moves the
task there and asks nothing further:

```bash
takt task instruction --current --complete review
```

Naming a step is a decision already taken, so there is no schema to satisfy, no
rule to match and no tag to read — it is how a step that really completes by
structured output gets moved past by hand, and it is checked before anything
else. Only the rules' own `next` steps are accepted; `COMPLETE` and `ABORT` are
understood but end the workflow rather than moving anywhere, so they are not
offered as destinations.

Nothing else moves a task. **With neither a named step nor a result the rules
can route, the pointer stays put — even where only one rule could ever have
matched.** A step reached without being judged to be reachable is worse than a
step not reached, so the command refuses rather than guesses:

| Refusal | Why |
|---|---|
| Result is not JSON, or fails the step's schema | The step declared what it owes; a result that does not satisfy it is not a completion |
| No `[STEP:N]` tag, where the step has labelled rules | The tag *is* the decision |
| The step routes on `all()` / `any()` | That reads how parallel children finished, which exists only inside a run |
| A rule reaches for state the result cannot supply | Reported by name; resolving it to nothing would take the wrong branch silently |
| The task is running | Its pointer belongs to the engine that is moving it |

Every refusal ends by naming the steps that can be given outright, since that
way past is always open.

A result routing to `COMPLETE` or `ABORT` ends the workflow; the command says so
and leaves the pointer where it is, since neither is a step a task can stand on.
When the engine would have paused for a human on the transition, the move still
happens and the command notes it on stderr.

Sites: `buildStepInstruction` and `extractExecutionContext` in
`src/features/tasks/fork/stepInstruction.ts`; `renderCompletionContract` and
`resolveSubmittedCompletion` in `src/features/tasks/fork/stepCompletion.ts`;
`printTaskInstruction` beside them; `readCompletionResult` in
`src/app/cli/fork/completionResult.ts`; `locateTask` in
`src/features/tasks/fork/taskPointer.ts`, shared with `takt task tree` so both
resolve the same step.
Tests: `src/__tests__/fork-task-instruction.test.ts`,
`src/__tests__/fork-step-completion.test.ts`.

### `takt workflow tree`

The same tree without a task. `--name` takes any identifier
`takt task add --workflow` accepts; `--full` expands every subworkflow.

```text
Workflow:    consult/consult
Description: A human checkpoint. The executor asks the human whatever it needs…
Steps:       2 selectable

consult/consult
├─ ask  ◀ initial
└─ review → review/consult-review
   └─ … 1 step
```

There is no run, so nothing is current and no branch is on a path: **every**
`workflow_call` collapses, and `--full` is the only way to open them. The
initial step is marked `◀ initial` because that is a property of the workflow
rather than of a run. `Steps: N selectable` counts the whole tree recursively,
so it matches what the collapsed `… N steps` lines add up to.

This is the only fork command that is **not** in the `takt task` group: upstream
already owns `takt workflow` (`init`, `doctor`, `inspect`), so the fork looks
that group up on the program and appends to it. No upstream edit, and no second
`workflow` group.

Sites: `renderWorkflowTree` in `src/features/tasks/fork/workflowTree.ts`,
`printWorkflowTree` beside it, registered from
`src/app/cli/fork/workflowCommands.ts`. The renderers live under
`features/tasks/fork` — not with the other workflow authoring commands —
because the tree is upstream's restart tree, which lives in
`features/tasks/taskRetryStartPath.ts`, and features in this codebase import
only `core`, `infra` and `shared`, never each other.
Tests: `src/__tests__/fork-workflow-tree.test.ts`.

### `takt task rewind`

Starts a pending, failed or completed task from a selected authored workflow
step, without opening the retry conversation:

```bash
takt task rewind --name my-task --step ask
```

**Rewind moves the task's current pointer, never its start pointer.** The
workflow the task was queued with is what runs, and the record's `workflow` is
never rewritten — only `restart_point` is. `--workflow` therefore does not
*choose* a workflow; it names one **reachable from the task's own** — the root
itself, or any workflow a `workflow_call` leads to — to say which of them
`--step` belongs to. A workflow the task cannot reach is refused, and the error
lists the ones it can:

```text
Workflow "review" is not reachable from "consult"; reachable workflows: "consult", "consult-review".
```

A workflow is *addressed* by its identifier, which is folder-qualified when the
YAML lives in a category subdirectory, while a restart entry records only the
workflow's `name` — so `consult/consult` and `consult` name the same thing here,
as do `review/consult-review` and `consult-review`. Both spellings are accepted,
wherever a workflow can be named: in `--workflow`, and in a `--step` path
segment. The identifier the task itself stores is accepted for its root
workflow even when the `name:` inside the YAML differs from the file name.

`--step` names an authored leaf: a plain step, never a `workflow_call` heading
or an engine-generated step. It takes three forms, which are the same form at
three lengths — a path whose segments are matched as a **suffix** of the step's
position in the tree:

| `--step` | Selects |
| --- | --- |
| `ask` | the only leaf named `ask`, wherever it sits |
| `consult-review/review` | the `review` leaf inside `consult-review` (or `review/consult-review/review`) |
| `consult/review > consult-review/review` | that leaf under that caller |

The third form matters because a callable workflow invoked from two places has
the same terminal `<workflow>/<step>` in both, so only naming a caller
separates them. An ambiguous `--step` is refused with the full paths of the
candidates — **and every path it prints is a value `--step` accepts**, so the
error can be resolved by copying one of its own suggestions.

Rewind creates a fresh execution and clears the previous resume checkpoint. It
reuses the task's existing project directory or worktree and retains the prior
failure note as retry context for failed tasks. It refuses a live running task,
and heals a task stuck `running` with a dead `owner_pid` the way `resume` and
`restart` do.

One sharp edge belongs to commander, not to the fork: a subcommand option whose
long name collides with a global one is stored in the global's slot, so
`--workflow` here and the top-level `-w` are the same value and cannot be told
apart. It is harmless because rewind only reads it — an inherited one either
names a reachable workflow or is refused by the error above; nothing is written
back either way.

Sites: `rewindTaskFromStep` in `src/features/tasks/restart/restartActions.ts`
and `resolveTaskRewindRestartPoint` in `src/features/tasks/restart/stepSelector.ts`,
which walks the same `buildTaskRetryRestartTree` the interactive retry picker
walks — so a step is selectable here exactly when it is selectable there.
Tests: `fork-task-rewind-selector`, `fork-restart-actions`.

### `takt task delete`

Finds the task whose name is exactly `--name`, in any state but running, and
asks `Delete <status> task "<name>"?` (default no) — the same question
`takt list` asks. Declining prints `Cancelled.`, deletes nothing and exits 0.
Past the prompt it mirrors upstream `deleteTaskByKind` in
`src/features/tasks/list/taskDeleteActions.ts`: a task with a branch has that
branch (and its worktree) deleted first, and the record is kept if that fails.
The few lines are copied rather than shared so the upstream file stays
untouched; keep them in step when upstream changes that function.

The task's runs and its `.takt/tasks/<dir>` task directory go with the record,
and the confirmation names them (`Delete failed task "kek" and its 3 runs
(216 KB) and its task directory?`). Runs are identified by the `task_dir`
stamp in `meta.json` and by the resume chain; see
[run directory lifecycle](takt-fork-spec.md#run-directory-lifecycle).

A task stuck `running` with a dead `owner_pid` is healed the same way `resume`
and `restart` heal it, so a task nothing is running can be deleted. The
difference is that delete calls `failInterruptedRunningTasks` only when the
named task reads as `running`: healing rewrites `tasks.yaml`, and a delete that
asks nothing and deletes nothing must leave the file byte-identical. A task a
live process owns stays `running` and is refused.

A missing or blank name, an unknown name, a running task, or a failed branch
cleanup prints an error and exits 1; the first four fail before asking.

Site: `deleteNamedTask` in `src/features/tasks/fork/deleteNamedTask.ts`.

### `takt task config`

Shows or sets the task-scoped keys of `.takt/config.yaml` without an editor.
With no option it prints every one of them and changes nothing:

```text
tasks_artifacts_dir: syncthing/docs/project/tasks
current_task: kek
```

An unset key prints `(not set)`. Both options may be given at once; each key is
set independently, and `""` clears either.

`--tasks-artifacts-dir <path>` sets it, `--tasks-artifacts-dir ""` clears it.
The value is trimmed, trailing slashes are stripped, and it must be a
**project-relative** forward-slash path: an absolute path, a backslash, an
empty segment, `.`, `..` or any whitespace is refused with
`Invalid --tasks-artifacts-dir "X": it <reason>.` and exit 1. Setting it prints
`Set tasks_artifacts_dir: X`, clearing it prints `Cleared tasks_artifacts_dir.`.

#### `--current-task` and `--current`

`--current-task <name>` records one task as the project's current task, and
every subcommand that takes `--name` then accepts `--current` in its place:

```bash
takt task config --current-task kek
takt task tree --current
takt task rewind --current --step ask
```

`--name` and `--current` are alternatives, never a fallback chain. Passing both
is refused (`Pass either --name or --current, not both.`) rather than silently
preferring one, and passing neither is refused with
`Missing required option '--name <name>' (or --current).` `--current` with no
key set is refused too, naming the command that sets it. Each is exit 1.

`add`, `list`, `config` and `prune` do not take `--current`: the first names a
task that does not exist yet, and the rest act on no single task.

Two rules keep the key from going stale:

- A `--current-task` value no task answers to is **refused**, leaving the key
  as it was. The alternative is a pointer that fails on every later command,
  with the typo far from where it was made.
- Deleting a task **clears** the key when it names that task — by `--name` or
  `--current`, either way.

The key is a command-line convenience only. Nothing in a run reads it: it never
reaches a workflow, a step, or a prompt, and it is not the same notion as the
current *step* that [`takt task tree`](#takt-task-tree) marks.

Sites: `src/features/tasks/fork/currentTask.ts` holds the key's accessors and
`resolveTaskName`, which every subcommand calls through `selectedName` in
`src/app/cli/fork/taskCommands.ts`; `configureTasks` sets it and
`deleteNamedTask` clears it. The key itself goes through the same three gates
as `tasks_artifacts_dir` — `ProjectConfigObjectBaseSchema`
(`config-schemas.ts`), `PROJECT_TRACKED_KEYS` (`tracedConfigSchema.ts`) and the
camel/snake mappings in `projectConfig.ts` — plus `ProjectConfig` in
`config-types.ts`. Miss one and the key loads as `undefined` with no error.
Tests: `src/__tests__/fork-current-task.test.ts`.

#### `{task_artifacts_dir}`

The key exists for one purpose: to give a step a durable, git-versioned place
to write per-task artifacts, addressable from an instruction template. With
`tasks_artifacts_dir: syncthing/docs/project/tasks` and a queued task named
`kek`, `{task_artifacts_dir}` in a step's instruction resolves to

```text
syncthing/docs/project/tasks/kek
```

Three properties, each deliberate:

- **Project-relative, unlike the absolute `{report_dir}`.** A worktree run gets
  a clone at a different path, and the same string has to mean the same file
  there and in a `git add`.
- **The leaf is `slugify(task.name)`**, not the timestamped run or task-dir
  slug, so every attempt at a task — resume, restart, rewind — writes to the
  same directory.
- **TAKT never creates it.** The step that writes creates it. An empty
  directory for a task that produced nothing is noise, and nothing reads the
  directory back.

A run with no queued task (interactive, `takt exec`) has no task name, and a
project that never set the key has no parent, so the placeholder renders the
plain notice `(no task artifacts directory for this run)` rather than throwing
or falling back to the parent directory. An invalid stored value is treated the
same way.

Two caveats a workflow author has to respect, neither specific to this key:
phase 2 has no tools at all, so the write belongs in phase 1; and a step with
`output_contracts` or `edit: false` has its edit tools stripped by
`filterAllowedToolsForEditPolicy`, so such a step cannot write there either.

Sites: `configureTasks` in `src/features/tasks/fork/configureTasks.ts`, and the
resolver and placeholder in
`src/core/workflow/instruction/fork/taskArtifactsDir.ts` (in `core/`, because
`escape.ts` calls it and `core/` may not import from `features/`). The upstream
edits it needs are each one line or one field: the key in
`ProjectConfigObjectBaseSchema` (`core/models/config-schemas.ts`),
`tasksArtifactsDir` on `ProjectConfig` (`core/models/config-types.ts`), the
load/save camel↔snake mappings (`infra/config/project/projectConfig.ts`), the
entry in `PROJECT_TRACKED_KEYS` (`infra/config/traced/tracedConfigSchema.ts`),
`taskArtifactsDir` on `WorkflowEngineOptions` (`core/workflow/types.ts`) and on
`InstructionContext` (`core/workflow/instruction/instruction-context.ts`), the
replace call in `escape.ts`, the `getTaskArtifactsDir` dep on `StepExecutor`
and its wiring in `WorkflowEngineSetup.ts`, the resolution in
`features/tasks/execute/taskWorkflowExecution.ts` — the only boundary that
holds both the project config and the queued task's name — and the two hops
between them: the field on `WorkflowExecutionOptions`
(`features/tasks/execute/types.ts`) and the line that forwards it in
`features/tasks/execute/workflowExecution.ts`. That last one is the whole
reason the first attempt rendered the notice in a real run: `executeWorkflow`
maps the engine options **field by field**, so an option it does not name
reaches no step, and the conditional spread that passed it at the call site
type-checked while doing nothing — a spread carries no excess-property check,
so the missing field on `WorkflowExecutionOptions` was never reported. Any
future fork option that has to reach a step needs both hops. `taskWorkflowExecution.ts`
also now passes its already-loaded config to `resolveReportFallbackProviderModel`
instead of letting it load the same file a second time. Tests:
`fork-task-config`, `fork-task-artifacts-dir`, and one case in the upstream
`workflow-execution-canonical` test — the only harness that constructs
`executeWorkflow` against a mock engine, which is where the dropped hop shows up.

### `takt task prune`

`delete` takes a task's own runs with it, which leaves everything deleted
before that existed, plus the runs that never had a task. `takt task prune`
takes no options and removes what no record in `tasks.yaml` accounts for:

```text
Delete 7 orphan runs and 2 orphan task directories (24.6 MB)?
```

A run is claimed by the same two routes `delete` uses — the `task_dir` stamp
and the resume chain — so a run any queued task still owns is never offered,
and prune is safe to run while tasks are queued or running. What is left over
is a run whose task was deleted before runs went with it, an interactive or
`takt exec` run, or a `debug-*` directory. An unreadable or missing
`meta.json` makes a run unattributable, and prune takes it; a run whose meta
says `running` is kept and reported, because an interactive run in progress
claims no task and is not garbage.

Under `.takt/tasks`, any directory no task's `task_dir` points at goes.

Declining prints `Cancelled.` and deletes nothing; a clean project prints
`Nothing to prune.` and asks nothing. A failed deletion is reported and sets a
non-zero exit code, and the rest still go.

Sites: `pruneOrphans` in `src/features/tasks/fork/pruneOrphans.ts`, over
`findOrphanDirectories` in `src/features/tasks/fork/orphanDirectories.ts`,
which shares its claiming logic with `taskRunDirectories.ts`
(`collectClaimedRunSlugs`). Test: `fork-task-prune`.

Tests live in `src/__tests__/fork-*.test.ts`: registration order, the group's
subcommands, options and help, the `takt list` help text, the command wiring,
the saved record, the table and its empty case, the deletion with and without
a branch, a declined confirmation, and each refusal of `add` and `delete`.
